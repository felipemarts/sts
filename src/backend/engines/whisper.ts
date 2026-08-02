import os from 'node:os';
import { ChildProcess, spawn } from 'node:child_process';
import { getSettings } from '../settings';
import { resolveBinary, getFreePort, sleep, encodeWav } from '../util';

interface ServerState {
  proc: ChildProcess;
  port: number;
  modelPath: string;
}

let server: ServerState | null = null;
let starting: Promise<ServerState> | null = null;

export function whisperBinary(): string | null {
  return resolveBinary('whisper-server', getSettings().whisperServerPath);
}

export function whisperStatus() {
  return {
    binaryPath: whisperBinary(),
    available: !!whisperBinary(),
    running: !!server,
    model: server?.modelPath ?? null,
  };
}

async function waitReady(port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
      return; // qualquer resposta HTTP significa que o servidor subiu
    } catch {
      await sleep(250);
    }
  }
  throw new Error('whisper-server não respondeu a tempo.');
}

async function startServer(modelPath: string): Promise<ServerState> {
  const bin = whisperBinary();
  if (!bin) {
    throw new Error(
      'whisper-server não encontrado. Instale o whisper.cpp (ex.: brew install whisper-cpp) ou defina o caminho nas Configurações.',
    );
  }
  const port = await getFreePort();
  const threads = Math.max(2, Math.min(8, os.cpus().length - 1));
  const proc = spawn(
    bin,
    ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout?.on('data', (d) => console.log('[whisper]', d.toString().trim()));
  proc.stderr?.on('data', (d) => console.log('[whisper]', d.toString().trim()));
  proc.on('exit', (code) => {
    console.log('[whisper] servidor encerrado, código', code);
    if (server?.proc === proc) server = null;
  });

  await waitReady(port);
  return { proc, port, modelPath };
}

/** Garante que o servidor está rodando com o modelo pedido. */
export async function ensureServer(modelPath: string): Promise<ServerState> {
  if (server && server.modelPath === modelPath) return server;
  if (starting) {
    const s = await starting;
    if (s.modelPath === modelPath) return s;
  }
  // modelo diferente (ou nada rodando): (re)inicia
  stopServer();
  starting = startServer(modelPath)
    .then((s) => {
      server = s;
      starting = null;
      return s;
    })
    .catch((err) => {
      starting = null;
      throw err;
    });
  return starting;
}

export function stopServer(): void {
  if (server) {
    try {
      server.proc.kill();
    } catch {
      /* ignore */
    }
    server = null;
  }
}

/**
 * Transcreve um segmento de PCM float32 mono. Retorna o texto.
 */
export async function transcribe(
  modelPath: string,
  pcm: Float32Array,
  sampleRate: number,
  language: string,
): Promise<string> {
  const s = await ensureServer(modelPath);
  const wav = encodeWav(pcm, sampleRate);

  const form = new FormData();
  const bytes = new Uint8Array(wav); // cópia com buffer ArrayBuffer (satisfaz BlobPart)
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (language && language !== 'auto') form.append('language', language);

  const res = await fetch(`http://127.0.0.1:${s.port}/inference`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`whisper-server erro ${res.status}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
