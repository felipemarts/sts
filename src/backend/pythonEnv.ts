/**
 * Ambiente Python embutido + setup dos motores que dependem dele (Piper e
 * Chatterbox).
 *
 * O app NÃO depende de nenhum Python instalado no sistema: quando o usuário
 * pede para instalar o Piper ou a Clonagem, baixamos um Python 3.11 relocável
 * (python-build-standalone — a mesma base usada pelo `uv`) para a pasta userData
 * e criamos os venvs a partir dele. Um único runtime serve os dois motores
 * (venvs separados: o do Piper é leve; o da clonagem puxa o PyTorch, ~2–3 GB).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../shared/types';
import {
  venvDir,
  venvPython,
  cloneVenvDir,
  cloneVenvPython,
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
 * bloqueou este arquivo"), quebrando a clonagem. Preferimos, então, um Python
 * do sistema quando existir: 3.12 → 3.11 → 3.10 (evitamos 3.13+ por falta de
 * wheels do torch). Retorna null se não houver — aí caímos no embutido.
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

export function cloneVenvReady(): boolean {
  return fs.existsSync(cloneVenvPython());
}

/** true se o pacote chatterbox é importável no venv de clonagem. */
export function chatterboxInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!cloneVenvReady()) return resolve(false);
    const p = spawn(cloneVenvPython(), ['-c', 'import chatterbox'], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
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

// ------------------------------- Clonagem (Chatterbox) -------------------------------

function emitClone(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.cloneSetupProgress, p);
  }
}

/**
 * Cria o venv de clonagem (a partir do Python 3.11 embutido) e instala
 * chatterbox-tts (+ PyTorch). Pesado. Idempotente.
 */
export async function setupCloneEnv(): Promise<void> {
  try {
    const py = await ensureBasePython(emitClone);

    // Migração importante: o venv criado do Python embutido tem o _lzma.pyd
    // bloqueado pelo Smart App Control (quebra o import do chatterbox). Se há um
    // Python do sistema (assinado), recria o venv com ele.
    if (systemTrustedPython() && cloneVenvReady() && venvIsEmbedded(cloneVenvDir())) {
      emitClone({
        stage: 'venv',
        message: 'Recriando o ambiente com o Python do sistema (corrige o bloqueio do Windows). Vai reinstalar as dependências…',
        done: false,
      });
      fs.rmSync(cloneVenvDir(), { recursive: true, force: true });
    }
    if (!cloneVenvReady()) {
      emitClone({ stage: 'venv', message: 'Criando ambiente Python isolado…', done: false });
      await run(py, ['-m', 'venv', cloneVenvDir()], 'Criação do venv de clonagem');
    }

    // setuptools<80 é necessário: o resemble-perth (do chatterbox) importa
    // pkg_resources, removido do setuptools 81+. A versão 79.x ainda o fornece.
    emitClone({ stage: 'pip', message: 'Atualizando pip e setuptools…', done: false });
    await run(
      cloneVenvPython(),
      ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools<80'],
      'Atualização do pip/setuptools',
    );

    if (!(await chatterboxInstalled())) {
      emitClone({
        stage: 'chatterbox',
        message: 'Instalando chatterbox-tts + PyTorch (~2–3 GB, pode levar vários minutos)…',
        done: false,
      });
      await run(
        cloneVenvPython(),
        ['-m', 'pip', 'install', 'chatterbox-tts'],
        'Instalação do chatterbox-tts',
        (line) => emitClone({ stage: 'chatterbox', message: line, done: false }),
      );
    }

    emitClone({ stage: 'done', message: 'Clonagem pronta.', done: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitClone({ stage: 'error', message: msg, done: true, error: msg });
    throw err;
  }
}
