/**
 * Ambiente Python embutido + setup dos motores que dependem dele (Piper e
 * faster-whisper).
 *
 * O app NÃO depende de nenhum Python instalado no sistema: quando o usuário
 * pede para instalar o Piper ou o Whisper, baixamos um Python 3.11 relocável
 * (python-build-standalone — a mesma base usada pelo `uv`) para a pasta userData
 * e criamos os venvs a partir dele. Um único runtime serve os dois motores
 * (venvs separados e leves).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../shared/types';
import {
  venvDir,
  venvPython,
  sttVenvDir,
  sttVenvPython,
  embeddedPython,
  embeddedPythonRoot,
  pythonDir,
} from './paths';
import {
  downloadFile,
  extractArchive,
  findLatestReleaseAsset,
  unblockDownloadedFiles,
  resolveBinary,
} from './util';

const PY_REPO = 'astral-sh/python-build-standalone';
const PY_SERIES = 'cpython-3.11.';

// ----------------------------- Python embutido -----------------------------

/** Triplo alvo do python-build-standalone para esta plataforma/arquitetura. */
function pythonTriple(): string {
  const arm = process.arch === 'arm64';
  switch (process.platform) {
    case 'win32':
      return arm ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    case 'darwin':
      return arm ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    default:
      return arm ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
}

export function pythonRuntimeReady(): boolean {
  return !!systemTrustedPython() || fs.existsSync(embeddedPython());
}

/**
 * Python "confiável" do sistema (assinado pela PSF — o Smart App Control do
 * Windows o aceita). O python-build-standalone embutido traz .pyd obscuras como
 * `_lzma.pyd` que o SAC BLOQUEIA ("Uma política de Controle de Aplicativo
 * bloqueou este arquivo"), quebrando os venvs. Preferimos, então, um Python
 * do sistema quando existir: 3.12 → 3.11 → 3.10. Retorna null se não houver —
 * aí caímos no embutido.
 */
export function systemTrustedPython(): string | null {
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const dirs: string[] = [];
  for (const v of ['312', '311', '310']) {
    if (local) dirs.push(path.join(local, 'Programs', 'Python', `Python${v}`, 'python.exe'));
    if (pf) dirs.push(path.join(pf, `Python${v}`, 'python.exe'));
    dirs.push(`C:\\Python${v}\\python.exe`);
  }
  for (const d of dirs) {
    if (fs.existsSync(d)) return d;
  }
  // Unix/macOS (ou PATH): pythons gerenciados pelo SO, também confiáveis.
  return (
    resolveBinary('python3.12') ||
    resolveBinary('python3.11') ||
    resolveBinary('python3.10')
  );
}

/** true se o venv foi criado a partir do Python embutido (base bloqueada pelo SAC). */
function venvIsEmbedded(dir: string): boolean {
  try {
    const cfg = fs.readFileSync(path.join(dir, 'pyvenv.cfg'), 'utf8');
    return cfg.toLowerCase().includes(embeddedPythonRoot().toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Python base para criar os venvs: prefere o do sistema (confiável); só baixa o
 * embutido se não houver Python no sistema.
 */
async function ensureBasePython(emit: (p: SetupProgress) => void): Promise<string> {
  const sys = systemTrustedPython();
  if (sys) return sys;
  return ensureEmbeddedPython(emit);
}

/**
 * Garante o Python 3.11 embutido; baixa e extrai na primeira vez. Retorna o
 * caminho do interpretador. `emit` recebe o progresso (roteado ao canal certo).
 */
export async function ensureEmbeddedPython(
  emit: (p: SetupProgress) => void,
): Promise<string> {
  if (pythonRuntimeReady()) return embeddedPython();

  emit({ stage: 'python', message: 'Procurando o Python 3.11 embutido…', done: false });
  const triple = pythonTriple();
  const asset = await findLatestReleaseAsset(
    PY_REPO,
    (name) =>
      name.includes(PY_SERIES) &&
      name.includes(triple) &&
      name.endsWith('install_only.tar.gz'),
  );
  if (!asset) {
    throw new Error(`Não encontrei um Python 3.11 embutido para ${triple}.`);
  }

  const archive = path.join(pythonDir(), asset.name);
  emit({ stage: 'python', message: 'Baixando o Python 3.11 (uma vez só, ~30 MB)…', done: false });
  await downloadFile(asset.browser_download_url, archive, (r, t) => {
    const pct = t ? Math.floor((r / t) * 100) : 0;
    emit({ stage: 'python', message: `Baixando o Python 3.11 — ${pct}%`, done: false });
  });

  emit({ stage: 'python', message: 'Extraindo o Python…', done: false });
  fs.rmSync(embeddedPythonRoot(), { recursive: true, force: true });
  await extractArchive(archive, embeddedPythonRoot()); // o tar contém uma pasta `python/`
  fs.rmSync(archive, { force: true });
  await unblockDownloadedFiles(embeddedPythonRoot()); // tira o Mark of the Web (Windows)

  const py = embeddedPython();
  if (!fs.existsSync(py)) throw new Error('Python embutido não encontrado após extrair.');
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(py, 0o755);
    } catch {
      /* ignore */
    }
  }
  return py;
}

// ------------------------------- Helpers -------------------------------

export function venvReady(): boolean {
  return fs.existsSync(venvPython());
}

/** true se o pacote piper é importável no venv do Piper. */
export function piperInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!venvReady()) return resolve(false);
    const p = spawn(venvPython(), ['-c', 'import piper'], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

export function sttVenvReady(): boolean {
  return fs.existsSync(sttVenvPython());
}

/** true se o pacote faster_whisper está instalado no venv de STT. */
export function fasterWhisperInstalled(): boolean {
  if (!sttVenvReady()) return false;
  const sitePkgs = process.platform === 'win32'
    ? path.join(sttVenvDir(), 'Lib', 'site-packages', 'faster_whisper')
    : path.join(sttVenvDir(), 'lib');
  if (process.platform === 'win32') return fs.existsSync(sitePkgs);
  // posix: procura faster_whisper em qualquer pythonX/site-packages
  try {
    const libDir = path.join(sttVenvDir(), 'lib');
    for (const py of fs.readdirSync(libDir)) {
      if (fs.existsSync(path.join(libDir, py, 'site-packages', 'faster_whisper'))) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function run(
  cmd: string,
  args: string[],
  stage: string,
  onLine?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const handle = (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && onLine) onLine(line.trim());
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${stage} falhou (código ${code})`));
    });
  });
}

// ------------------------------- Piper (TTS local) -------------------------------

function emitPiper(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.piperSetupProgress, p);
  }
}

/**
 * Garante o venv do Piper com piper-tts instalado, criando-o a partir do Python
 * embutido (baixa o Python se ainda não houver). Idempotente.
 */
export async function setupPiperEnv(): Promise<void> {
  try {
    const py = await ensureBasePython(emitPiper);

    // Se há Python do sistema e o venv atual veio do embutido (bloqueado pelo
    // SAC no Windows), recria com o do sistema.
    if (systemTrustedPython() && venvReady() && venvIsEmbedded(venvDir())) {
      emitPiper({ stage: 'venv', message: 'Recriando o ambiente com o Python do sistema…', done: false });
      fs.rmSync(venvDir(), { recursive: true, force: true });
    }
    if (!venvReady()) {
      emitPiper({ stage: 'venv', message: 'Criando ambiente Python isolado…', done: false });
      await run(py, ['-m', 'venv', venvDir()], 'Criação do venv');
    }

    emitPiper({ stage: 'pip', message: 'Atualizando o pip…', done: false });
    await run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], 'Atualização do pip');

    if (!(await piperInstalled())) {
      emitPiper({ stage: 'piper', message: 'Instalando piper-tts (pode levar ~1 min)…', done: false });
      await run(
        venvPython(),
        ['-m', 'pip', 'install', 'piper-tts'],
        'Instalação do piper-tts',
        (line) => emitPiper({ stage: 'piper', message: line, done: false }),
      );
    }

    emitPiper({ stage: 'done', message: 'Piper pronto.', done: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitPiper({ stage: 'error', message: msg, done: true, error: msg });
    throw err;
  }
}

// ------------------------------- STT (faster-whisper) -------------------------------

function emitStt(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.whisperSetupProgress, p);
  }
}

/**
 * Garante o venv de STT com faster-whisper instalado. Usa o Python assinado do
 * sistema (o SAC bloqueia o whisper.cpp não-assinado). Idempotente.
 */
export async function setupSttEnv(): Promise<void> {
  try {
    const py = await ensureBasePython(emitStt);

    if (systemTrustedPython() && sttVenvReady() && venvIsEmbedded(sttVenvDir())) {
      emitStt({ stage: 'venv', message: 'Recriando o ambiente com o Python do sistema…', done: false });
      fs.rmSync(sttVenvDir(), { recursive: true, force: true });
    }
    if (!sttVenvReady()) {
      emitStt({ stage: 'venv', message: 'Criando ambiente Python isolado…', done: false });
      await run(py, ['-m', 'venv', sttVenvDir()], 'Criação do venv de STT');
    }

    if (!fasterWhisperInstalled()) {
      emitStt({ stage: 'pip', message: 'Atualizando o pip…', done: false });
      await run(sttVenvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], 'Atualização do pip');
      emitStt({ stage: 'whisper', message: 'Instalando faster-whisper (~200 MB)…', done: false });
      await run(
        sttVenvPython(),
        ['-m', 'pip', 'install', 'faster-whisper'],
        'Instalação do faster-whisper',
        (line) => emitStt({ stage: 'whisper', message: line, done: false }),
      );
    }

    emitStt({ stage: 'done', message: 'Whisper (Python) pronto.', done: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitStt({ stage: 'error', message: msg, done: true, error: msg });
    throw err;
  }
}
