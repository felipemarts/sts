// Captura de microfone + VAD por energia (RMS) usando um AudioWorklet.
// O worklet apenas repassa blocos de PCM; a máquina de estados do VAD roda aqui.

const WORKLET_CODE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    this._target = 1024; // ~64ms @16kHz
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      this._buf.push(new Float32Array(ch));
      this._count += ch.length;
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

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const minSpeechMs = opts.minSpeechMs ?? 250;
  const maxSegmentMs = opts.maxSegmentMs ?? 20000;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const ctx = new AudioContext({ sampleRate: 16000 });
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
      opts.onSegment(merged, sampleRate);
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
        // inicia o segmento com o pré-roll para não cortar o início da fala
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

    // atualiza pré-roll (janela deslizante)
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
