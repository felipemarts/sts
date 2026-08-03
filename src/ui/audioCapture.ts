// Captura de microfone + VAD por energia (RMS) usando um AudioWorklet.
// O worklet apenas repassa blocos de PCM; a máquina de estados do VAD roda aqui.
//
// IMPORTANTE: capturamos na taxa NATIVA do dispositivo e reamostramos para 16 kHz
// só no fim de cada segmento. Forçar `new AudioContext({sampleRate:16000})` faz o
// MediaStreamSource entregar SILÊNCIO em muitos setups (bug conhecido do Chromium).

const TARGET_RATE = 16000;

const WORKLET_CODE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    this._target = Math.max(256, Math.round(sampleRate * 0.05)); // ~50ms
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this._buf.push(new Float32Array(input[0]));
      this._count += input[0].length;
      if (this._count >= this._target) {
        const out = new Float32Array(this._count);
        let o = 0;
        for (const b of this._buf) { out.set(b, o); o += b.length; }
        this._buf = [];
        this._count = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export interface CaptureOptions {
  deviceId?: string | null;
  threshold: number; // RMS 0..1
  hangoverMs: number; // silêncio para encerrar o segmento
  minSpeechMs?: number;
  maxSegmentMs?: number;
  onLevel?: (rms: number) => void;
  onSegment: (pcm: Float32Array, sampleRate: number) => void;
  onError?: (err: Error) => void;
}

export interface CaptureHandle {
  stop: () => Promise<void>;
  sampleRate: number;
}

function rmsOf(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
}

/** Reamostra PCM float32 para `toRate` por interpolação linear. */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (idx - i0);
  }
  return out;
}

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

async function getMicStream(deviceId?: string | null): Promise<MediaStream> {
  const base: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
    });
  } catch (err) {
    // deviceId inválido/ausente → tenta o microfone padrão do sistema
    if (deviceId) {
      return navigator.mediaDevices.getUserMedia({ audio: base });
    }
    throw err;
  }
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const minSpeechMs = opts.minSpeechMs ?? 250;
  const maxSegmentMs = opts.maxSegmentMs ?? 20000;

  const stream = await getMicStream(opts.deviceId);

  const ctx = new AudioContext(); // taxa NATIVA (evita silêncio do MediaStreamSource)
  await ctx.resume();
  const sampleRate = ctx.sampleRate;

  const blobUrl = URL.createObjectURL(
    new Blob([WORKLET_CODE], { type: 'application/javascript' }),
  );
  await ctx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture-processor');
  const zeroGain = ctx.createGain();
  zeroGain.gain.value = 0; // mantém o grafo "puxando" sem áudio audível
  source.connect(node);
  node.connect(zeroGain);
  zeroGain.connect(ctx.destination);

  // Estado do VAD
  let speaking = false;
  let silenceMs = 0;
  let segment: Float32Array[] = [];
  let segmentMs = 0;
  const preroll: Float32Array[] = [];
  let prerollMs = 0;
  const PREROLL_MS = 300;

  const chunkMs = (n: number) => (n / sampleRate) * 1000;

  const finalize = () => {
    if (segmentMs >= minSpeechMs && segment.length) {
      const total = segment.reduce((a, b) => a + b.length, 0);
      const merged = new Float32Array(total);
      let o = 0;
      for (const b of segment) {
        merged.set(b, o);
        o += b.length;
      }
      // reamostra para 16 kHz (o que o whisper.cpp espera)
      const out = resample(merged, sampleRate, TARGET_RATE);
      opts.onSegment(out, TARGET_RATE);
    }
    segment = [];
    segmentMs = 0;
    silenceMs = 0;
    speaking = false;
  };

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    const chunk = ev.data;
    const ms = chunkMs(chunk.length);
    const rms = rmsOf(chunk);
    if (opts.onLevel) opts.onLevel(rms);

    if (rms >= opts.threshold) {
      if (!speaking) {
        speaking = true;
        segment = [...preroll];
        segmentMs = prerollMs;
      }
      segment.push(chunk);
      segmentMs += ms;
      silenceMs = 0;
      if (segmentMs >= maxSegmentMs) finalize();
    } else if (speaking) {
      segment.push(chunk);
      segmentMs += ms;
      silenceMs += ms;
      if (silenceMs >= opts.hangoverMs) finalize();
    }

    preroll.push(chunk);
    prerollMs += ms;
    while (prerollMs > PREROLL_MS && preroll.length > 1) {
      const removed = preroll.shift()!;
      prerollMs -= chunkMs(removed.length);
    }
  };

  node.port.onmessageerror = () => opts.onError?.(new Error('Erro no worklet de áudio'));

  const stop = async () => {
    try {
      if (speaking) finalize();
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      zeroGain.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    } catch {
      /* ignore */
    }
  };

  return { stop, sampleRate };
}
