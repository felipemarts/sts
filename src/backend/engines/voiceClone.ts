import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../../shared/types';
import {
  cloneVenvPython,
  cloneWorkerPath,
  cloneRefPath,
  hfCacheDir,
  tmpDir,
} from '../paths';
import { CLONE_WORKER_SOURCE } from './cloneWorkerSource';

interface Pending {
  resolve: (wavPath: string) => void;
  reject: (err: Error) => void;
  out: string;
}

let proc: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let ready = false;
let pending: Pending | null = null;
let stdoutBuf = '';
let counter = 0;

export function cloneRunning(): boolean {
  return !!proc && ready;
}

function emitProgress(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.cloneSetupProgress, p);
  }
}

function handleLine(line: string) {
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
    ready = true;
    return;
  }
  // resposta de uma síntese
  if (pending) {
    const p = pending;
    pending = null;
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(p.out);
  }
}

async function startWorker(): Promise<void> {
  fs.writeFileSync(cloneWorkerPath(), CLONE_WORKER_SOURCE, 'utf8');
  emitProgress({ stage: 'model', message: 'Carregando o modelo de clonagem…', done: false });

  const child = spawn(cloneVenvPython(), [cloneWorkerPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HF_HOME: hfCacheDir(),
      PYTORCH_ENABLE_MPS_FALLBACK: '1',
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  proc = child;
  ready = false;

  child.stdout!.on('data', (d: Buffer) => {
    stdoutBuf += d.toString();
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleLine(line);
    }
  });
  child.stderr!.on('data', (d: Buffer) => console.log('[clone:err]', d.toString().trim()));
  child.on('exit', (code) => {
    console.log('[clone] worker encerrado, código', code);
    if (proc === child) {
      proc = null;
      ready = false;
    }
    if (pending) {
      pending.reject(new Error('O processo de clonagem encerrou inesperadamente.'));
      pending = null;
    }
  });

  // aguarda o "ready" (inclui possível download do modelo ~1GB na 1ª vez)
  const start = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  while (!ready) {
    if (!proc) throw new Error('O worker de clonagem não iniciou.');
    if (Date.now() - start > timeoutMs) throw new Error('Timeout carregando o modelo de clonagem.');
    await new Promise((r) => setTimeout(r, 200));
  }
  emitProgress({ stage: 'done', message: 'Modelo pronto.', done: true });
}

export async function ensureWorker(): Promise<void> {
  if (proc && ready) return;
  if (starting) return starting;
  starting = startWorker()
    .then(() => {
      starting = null;
    })
    .catch((err) => {
      starting = null;
      stopWorker();
      throw err;
    });
  return starting;
}

export function stopWorker(): void {
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    proc = null;
    ready = false;
  }
}

/**
 * Sintetiza `text` com a voz de referência salva, retornando os bytes do WAV.
 * Serial: uma síntese por vez (o worker processa uma requisição de cada vez).
 */
export async function synthClone(text: string, language: string): Promise<Buffer> {
  const ref = cloneRefPath();
  if (!fs.existsSync(ref)) {
    throw new Error('Nenhuma amostra de referência gravada. Grave uma amostra primeiro.');
  }
  await ensureWorker();
  if (pending) {
    throw new Error('Já há uma síntese em andamento. Aguarde terminar.');
  }

  const out = path.join(tmpDir(), `clone_${process.pid}_${counter++}.wav`);
  const wavPath = await new Promise<string>((resolve, reject) => {
    pending = { resolve, reject, out };
    const req = JSON.stringify({ text, ref, language, out }) + '\n';
    proc!.stdin!.write(req);
  });

  const buf = fs.readFileSync(wavPath);
  fs.rmSync(wavPath, { force: true });
  return buf;
}
