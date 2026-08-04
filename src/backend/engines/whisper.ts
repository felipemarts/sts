/**
 * STT local via faster-whisper (CTranslate2), rodando num venv Python.
 *
 * Por que NÃO whisper.cpp: em máquinas com Smart App Control (SAC) ligado, o
 * binário não-assinado do whisper.cpp é BLOQUEADO ("Uma política de Controle de
 * Aplicativo bloqueou este arquivo"). O faster-whisper roda no Python assinado
 * do sistema e usa o ctranslate2 (wheel amplamente distribuído que o SAC
 * aceita) — sem executável não-assinado. É também mais rápido na CPU.
 *
 * O modelo (por nome: tiny/base/small/medium/large-v3…) é baixado pelo próprio
 * faster-whisper no cache HF. Um worker Python persistente mantém o modelo em
 * memória; a transcrição escreve o PCM num WAV temporário e manda ao worker.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../../shared/types';
import { encodeWav } from '../util';
import { sttVenvPython, sttWorkerPath, sttHfCacheDir, tmpDir } from '../paths';
import { sttVenvReady, fasterWhisperInstalled, setupSttEnv } from '../pythonEnv';
import { STT_WORKER_SOURCE } from './sttWorkerSource';

let installing = false;

/** Mapeia o id do catálogo → nome do modelo faster-whisper. */
const FW_NAME: Record<string, string> = {
  tiny: 'tiny',
  base: 'base',
  small: 'small',
  medium: 'medium',
  'large-v3': 'large-v3',
  'large-v3-turbo': 'large-v3-turbo',
};
export function fwModelName(id: string): string {
  return FW_NAME[id] ?? id;
}

/** Diretório do modelo CT2 no cache do HuggingFace. */
export function sttModelCacheDir(id: string): string {
  return path.join(sttHfCacheDir(), 'hub', `models--Systran--faster-whisper-${fwModelName(id)}`);
}
export function sttModelCached(id: string): boolean {
  // "snapshots" com conteúdo = download concluído (o dir raiz existe cedo demais).
  const snap = path.join(sttModelCacheDir(id), 'snapshots');
  try {
    return fs.readdirSync(snap).some((s) => fs.readdirSync(path.join(snap, s)).length > 0);
  } catch {
    return false;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { total += fs.statSync(p).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/** Baixa o modelo CT2 do faster-whisper (garante o venv antes). */
export async function downloadSttModel(id: string, onBytes: (n: number) => void): Promise<void> {
  await setupSttEnv();
  const name = fwModelName(id);
  const cacheDir = sttModelCacheDir(id);
  const poll = setInterval(() => onBytes(dirSize(cacheDir)), 600);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        sttVenvPython(),
        ['-c', `from faster_whisper import WhisperModel; WhisperModel('${name}', device='cpu', compute_type='int8')`],
        {
          windowsHide: true,
          env: {
            ...process.env,
            HF_HOME: sttHfCacheDir(),
            HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
            TOKENIZERS_PARALLELISM: 'false',
          },
        },
      );
      let err = '';
      p.stderr?.on('data', (c) => (err += c.toString()));
      p.on('error', reject);
      p.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Falha ao baixar o modelo (código ${code}): ${err.slice(-300)}`)),
      );
    });
  } finally {
    clearInterval(poll);
  }
}

export function canAutoInstall(): boolean {
  return true;
}

export function whisperStatus() {
  return {
    binaryPath: sttVenvReady() ? sttVenvPython() : null,
    available: fasterWhisperInstalled(),
    installing,
    canAutoInstall: true,
    platform: process.platform,
  };
}

/** Instala o ambiente Python de STT (venv + faster-whisper). */
export async function installWhisperBinary(): Promise<void> {
  if (installing) throw new Error('Instalação do Whisper já em andamento.');
  installing = true;
  try {
    await setupSttEnv();
  } finally {
    installing = false;
  }
}

function emitProgress(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.whisperSetupProgress, p);
  }
}

// -------------------------------- worker --------------------------------

interface SttWorker {
  proc: ChildProcess;
  ready: boolean;
  model: string;
  buf: string;
  pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null;
}

let worker: SttWorker | null = null;
let starting: Promise<SttWorker> | null = null;
const queue: Array<{ wav: string; language: string; resolve: (t: string) => void; reject: (e: Error) => void }> = [];

function threads(): number {
  // 0 = CTranslate2 usa todos os núcleos físicos (mais rápido). Fallback seguro
  // caso a contagem de CPUs não esteja disponível.
  return os.cpus().length > 0 ? 0 : 4;
}

function handleLine(w: SttWorker, line: string) {
  const t = line.trim();
  if (!t) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(t);
  } catch {
    console.log('[stt]', t);
    return;
  }
  if (msg.log) {
    emitProgress({ stage: 'model', message: String(msg.log), done: false });
    return;
  }
  if (msg.ready) {
    w.ready = true;
    console.log(`[stt] worker pronto (modelo=${w.model})`);
    dispatch();
    return;
  }
  if (w.pending) {
    const p = w.pending;
    w.pending = null;
    if (msg.error) {
      console.log('[stt] erro do worker:', msg.error);
      p.reject(new Error(String(msg.error)));
    } else {
      p.resolve(typeof msg.text === 'string' ? msg.text : '');
    }
    dispatch();
  } else if (msg.error) {
    console.log('[stt] erro de inicialização do worker:', msg.error);
  }
}

function spawnWorker(model: string): Promise<SttWorker> {
  fs.writeFileSync(sttWorkerPath(), STT_WORKER_SOURCE, 'utf8');
  const child = spawn(sttVenvPython(), [sttWorkerPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      HF_HOME: sttHfCacheDir(),
      STS_STT_MODEL: model,
      STS_STT_THREADS: String(threads()),
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  const w: SttWorker = { proc: child, ready: false, model, buf: '', pending: null };
  worker = w; // atribui JÁ: o dispatch() precisa ver o worker durante o load (evita corrida)
  child.stdout!.on('data', (d: Buffer) => {
    w.buf += d.toString();
    let idx: number;
    while ((idx = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, idx);
      w.buf = w.buf.slice(idx + 1);
      handleLine(w, line);
    }
  });
  child.stderr!.on('data', (d: Buffer) => console.log('[stt:err]', d.toString().trim()));
  child.on('exit', () => {
    if (worker === w) worker = null;
    if (w.pending) {
      w.pending.reject(new Error('O processo de STT encerrou inesperadamente.'));
      w.pending = null;
    }
  });

  return new Promise<SttWorker>((resolve, reject) => {
    const start = Date.now();
    const tick = setInterval(() => {
      if (w.ready) {
        clearInterval(tick);
        resolve(w);
      } else if (w.proc.exitCode !== null) {
        clearInterval(tick);
        reject(new Error('O worker de STT não iniciou.'));
      } else if (Date.now() - start > 10 * 60 * 1000) {
        clearInterval(tick);
        reject(new Error('Timeout carregando o modelo de STT.'));
      }
    }, 120);
  });
}

async function ensureWorker(model: string): Promise<void> {
  if (worker && worker.model === model && worker.ready) return;
  if (worker && worker.model !== model) {
    // modelo mudou → descarta o worker (e o load) antigo
    try { worker.proc.kill(); } catch { /* ignore */ }
    worker = null;
    starting = null;
  }
  if (!starting) starting = spawnWorker(model); // spawnWorker já atribui `worker`
  const s = starting;
  try {
    await s; // resolve quando o worker fica pronto
  } finally {
    if (starting === s) starting = null;
  }
}

function dispatch() {
  if (!worker || !worker.ready || worker.pending) return;
  const job = queue.shift();
  if (!job) return;
  worker.pending = { resolve: job.resolve, reject: job.reject };
  console.log('[stt] enviando trecho ao worker');
  try {
    worker.proc.stdin!.write(JSON.stringify({ wav: job.wav, language: job.language }) + '\n');
  } catch (e) {
    worker.pending = null;
    job.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Transcreve um segmento de PCM float32 mono. `modelId` é o id do catálogo
 * (tiny/base/small/medium/large-v3…). Retorna o texto.
 */
export async function transcribe(
  modelId: string,
  pcm: Float32Array,
  sampleRate: number,
  language: string,
): Promise<string> {
  if (!fasterWhisperInstalled()) {
    throw new Error('Whisper (Python) não instalado. Vá em Configurações e clique em "Instalar Whisper".');
  }
  console.log(`[stt] transcribe: modelo=${fwModelName(modelId)} amostras=${pcm.length} sr=${sampleRate}`);
  try {
    await ensureWorker(fwModelName(modelId));
  } catch (e) {
    console.log('[stt] falha ao iniciar o worker:', e instanceof Error ? e.message : String(e));
    throw e;
  }

  const wavPath = path.join(tmpDir(), `stt-${process.hrtime.bigint()}.wav`);
  fs.writeFileSync(wavPath, encodeWav(pcm, sampleRate));
  try {
    return await new Promise<string>((resolve, reject) => {
      queue.push({ wav: wavPath, language: language || 'auto', resolve, reject });
      dispatch();
    });
  } finally {
    fs.rm(wavPath, { force: true }, () => {});
  }
}

/**
 * Pré-carrega o modelo no worker (sem transcrever), para o 1º trecho não pagar
 * o tempo de importar o faster-whisper + carregar o modelo (~30-50s na 1ª vez).
 * Emite progresso via whisperSetupProgress (a UI mostra "Carregando modelo…").
 */
export async function warmup(modelId: string): Promise<void> {
  if (!fasterWhisperInstalled()) return;
  try {
    await ensureWorker(fwModelName(modelId));
    emitProgress({ stage: 'done', message: 'Modelo de voz pronto.', done: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitProgress({ stage: 'error', message: msg, done: true, error: msg });
  }
}

/** Para a captura: descarta a fila (o modelo fica carregado p/ a próxima). */
export function stopWhisper(): void {
  while (queue.length) {
    const job = queue.shift()!;
    job.resolve(''); // cancelado, sem erro
  }
}

/** Encerra de vez o worker de STT (ao fechar o app). */
export function shutdownWhisper(): void {
  stopWhisper();
  if (worker) {
    try { worker.proc.kill(); } catch { /* ignore */ }
    worker = null;
  }
}
