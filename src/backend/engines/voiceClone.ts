import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../../shared/types';
import { getSettings } from '../settings';
import {
  cloneVenvPython,
  cloneWorkerPath,
  cloneRefPath,
  hfCacheDir,
  tmpDir,
} from '../paths';
import { CLONE_WORKER_SOURCE } from './cloneWorkerSource';

/**
 * Pool de workers de clonagem (Chatterbox). Cada worker é um processo Python
 * persistente com o modelo em memória. O tamanho do pool (clonePoolSize) permite
 * gerar N frases em paralelo — cada worker custa ~2–3GB de RAM, então o padrão
 * é 1. A síntese é por FRASE (o estúdio de segmentos manda uma de cada vez).
 */
interface PoolWorker {
  proc: ChildProcess;
  ready: boolean;
  busy: boolean;
  stdoutBuf: string;
  pending: { resolve: (p: string) => void; reject: (e: Error) => void; out: string } | null;
}

interface Job {
  text: string;
  ref: string;
  language: string;
  out: string;
  resolve: (p: string) => void;
  reject: (e: Error) => void;
}

let pool: PoolWorker[] = [];
let ensuring: Promise<void> | null = null;
const queue: Job[] = [];
let counter = 0;

export function cloneRunning(): boolean {
  return pool.some((w) => w.ready);
}

function emitProgress(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.cloneSetupProgress, p);
  }
}

function handleLine(w: PoolWorker, line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    console.log('[clone]', trimmed);
    return;
  }
  if (msg.log) {
    emitProgress({ stage: 'model', message: String(msg.log), done: false });
    return;
  }
  if (msg.ready) {
    w.ready = true;
    return;
  }
  // resposta de uma síntese
  if (w.pending) {
    const p = w.pending;
    w.pending = null;
    w.busy = false;
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(p.out);
    dispatch(); // libera a fila para este worker
  }
}

function spawnWorker(): Promise<PoolWorker> {
  fs.writeFileSync(cloneWorkerPath(), CLONE_WORKER_SOURCE, 'utf8');
  const child = spawn(cloneVenvPython(), [cloneWorkerPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HF_HOME: hfCacheDir(),
      PYTORCH_ENABLE_MPS_FALLBACK: '1',
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  const w: PoolWorker = { proc: child, ready: false, busy: false, stdoutBuf: '', pending: null };

  child.stdout!.on('data', (d: Buffer) => {
    w.stdoutBuf += d.toString();
    let idx: number;
    while ((idx = w.stdoutBuf.indexOf('\n')) >= 0) {
      const line = w.stdoutBuf.slice(0, idx);
      w.stdoutBuf = w.stdoutBuf.slice(idx + 1);
      handleLine(w, line);
    }
  });
  child.stderr!.on('data', (d: Buffer) => console.log('[clone:err]', d.toString().trim()));
  child.on('exit', (code) => {
    console.log('[clone] worker encerrado, código', code);
    pool = pool.filter((x) => x !== w);
    if (w.pending) {
      w.pending.reject(new Error('O processo de clonagem encerrou inesperadamente.'));
      w.pending = null;
    }
  });

  // aguarda o "ready" (inclui possível download do modelo ~1GB na 1ª vez)
  return new Promise<PoolWorker>((resolve, reject) => {
    const start = Date.now();
    const timeoutMs = 15 * 60 * 1000;
    const tick = setInterval(() => {
      if (w.ready) {
        clearInterval(tick);
        resolve(w);
      } else if (!pool.includes(w) && pool.length >= 0 && w.proc.exitCode !== null) {
        clearInterval(tick);
        reject(new Error('O worker de clonagem não iniciou.'));
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(tick);
        reject(new Error('Timeout carregando o modelo de clonagem.'));
      }
    }, 150);
  });
}

/** Garante ao menos `size` workers prontos (não reduz workers já vivos). */
async function ensurePool(size: number): Promise<void> {
  const target = Math.max(1, Math.min(3, size || 1));
  if (ensuring) await ensuring;
  if (pool.length >= target) return;
  ensuring = (async () => {
    emitProgress({ stage: 'model', message: 'Carregando o modelo de clonagem…', done: false });
    while (pool.length < target) {
      const w = await spawnWorker();
      pool.push(w);
    }
    emitProgress({ stage: 'done', message: 'Modelo pronto.', done: true });
  })();
  try {
    await ensuring;
  } finally {
    ensuring = null;
  }
}

/** Envia jobs da fila para workers livres. */
function dispatch(): void {
  for (const w of pool) {
    if (w.busy || !w.ready) continue;
    const job = queue.shift();
    if (!job) return;
    w.busy = true;
    w.pending = { resolve: job.resolve, reject: job.reject, out: job.out };
    const req = JSON.stringify({ text: job.text, ref: job.ref, language: job.language, out: job.out }) + '\n';
    try {
      w.proc.stdin!.write(req);
    } catch (e) {
      w.busy = false;
      w.pending = null;
      job.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/**
 * Sintetiza UMA frase/segmento com a voz de referência. Roteado para um worker
 * livre do pool (permite paralelismo até clonePoolSize). Retorna bytes do WAV.
 */
export async function synthSegment(text: string, language: string): Promise<Buffer> {
  const ref = cloneRefPath();
  if (!fs.existsSync(ref)) {
    throw new Error('Nenhuma amostra de referência gravada. Grave uma amostra primeiro.');
  }
  await ensurePool(getSettings().clonePoolSize);

  const out = path.join(tmpDir(), `clone_${process.pid}_${counter++}.wav`);
  const wavPath = await new Promise<string>((resolve, reject) => {
    queue.push({ text, ref, language, out, resolve, reject });
    dispatch();
  });
  const buf = fs.readFileSync(wavPath);
  fs.rmSync(wavPath, { force: true });
  return buf;
}

/** Compat: sintetiza um texto inteiro como um único job (o worker chunk-a internamente). */
export function synthClone(text: string, language: string): Promise<Buffer> {
  return synthSegment(text, language);
}

export function stopWorker(): void {
  for (const w of pool) {
    if (w.pending) {
      w.pending.reject(new Error('Geração cancelada.'));
      w.pending = null;
    }
    try {
      w.proc.kill();
    } catch {
      /* ignore */
    }
  }
  for (const j of queue) j.reject(new Error('Geração cancelada.'));
  queue.length = 0;
  pool = [];
}
