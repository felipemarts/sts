// Gravação de PCM mono de duração fixa (para a amostra de referência da clonagem).
// Reusa a técnica de AudioWorklet via blob de audioCapture.ts, mas sem VAD.

const WORKLET_CODE = `
class RecProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('rec-processor', RecProcessor);
`;

export interface RecordController {
  done: Promise<{ pcm: Float32Array; sampleRate: number }>;
  stop: () => void;
}

export interface RecordOptions {
  deviceId?: string | null;
  maxDurationMs: number;
  onLevel?: (rms: number) => void;
  onTick?: (elapsedMs: number) => void;
}

function rms(chunk: Float32Array): number {
  let s = 0;
  for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i];
  return Math.sqrt(s / chunk.length);
}

export async function startRecording(opts: RecordOptions): Promise<RecordController> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      channelCount: 1,
      // Preserva o timbre natural para a clonagem (sem processamento).
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // Chatterbox usa 24 kHz internamente — grava já nessa taxa.
  const ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.resume();
  const sampleRate = ctx.sampleRate;

  const blobUrl = URL.createObjectURL(
    new Blob([WORKLET_CODE], { type: 'application/javascript' }),
  );
  await ctx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'rec-processor');
  const zeroGain = ctx.createGain();
  zeroGain.gain.value = 0;
  source.connect(node);
  node.connect(zeroGain);
  zeroGain.connect(ctx.destination);

  const chunks: Float32Array[] = [];
  let collected = 0;
  const maxSamples = Math.floor((opts.maxDurationMs / 1000) * sampleRate);
  let finished = false;

  let resolveDone!: (v: { pcm: Float32Array; sampleRate: number }) => void;
  const done = new Promise<{ pcm: Float32Array; sampleRate: number }>((res) => {
    resolveDone = res;
  });

  const finalize = () => {
    if (finished) return;
    finished = true;
    node.port.onmessage = null;
    try {
      source.disconnect();
      node.disconnect();
      zeroGain.disconnect();
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    const merged = new Float32Array(collected);
    let o = 0;
    for (const c of chunks) {
      merged.set(c.subarray(0, Math.min(c.length, collected - o)), o);
      o += c.length;
      if (o >= collected) break;
    }
    ctx.close();
    resolveDone({ pcm: merged, sampleRate });
  };

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (finished) return;
    const chunk = ev.data;
    chunks.push(chunk);
    collected += chunk.length;
    if (opts.onLevel) opts.onLevel(rms(chunk));
    if (opts.onTick) opts.onTick((collected / sampleRate) * 1000);
    if (collected >= maxSamples) finalize();
  };

  return { done, stop: finalize };
}
