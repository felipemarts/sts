import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../shared/types';
import { venvDir, venvPython, cloneVenvDir, cloneVenvPython } from './paths';
import { resolveBinary } from './util';

/** Localiza um python3 do sistema para criar o venv. */
export function systemPython(): string | null {
  return resolveBinary('python3') || resolveBinary('python');
}

/** Localiza um Python 3.11 (ou 3.10) — exigido pelo chatterbox/torch. */
export function python311(): string | null {
  return resolveBinary('python3.11') || resolveBinary('python3.10');
}

export function venvReady(): boolean {
  return fs.existsSync(venvPython());
}

/** true se o pacote piper está importável no venv. */
export function piperInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!venvReady()) return resolve(false);
    const p = spawn(venvPython(), ['-c', 'import piper']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function emit(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.piperSetupProgress, p);
  }
}

function run(
  cmd: string,
  args: string[],
  stage: string,
  onLine?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Garante o venv com piper-tts instalado. Cria o venv se preciso e instala o
 * pacote via pip. Idempotente. Emite progresso para o renderer.
 */
export async function setupPiperEnv(): Promise<void> {
  try {
    const py = systemPython();
    if (!py) {
      throw new Error(
        'Python 3 não encontrado no sistema. Instale o Python 3 (ex.: brew install python) e tente de novo.',
      );
    }

    if (!venvReady()) {
      emit({ stage: 'venv', message: 'Criando ambiente Python isolado…', done: false });
      await run(py, ['-m', 'venv', venvDir()], 'Criação do venv');
    }

    emit({ stage: 'pip', message: 'Atualizando pip…', done: false });
    await run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], 'Atualização do pip');

    if (!(await piperInstalled())) {
      emit({ stage: 'piper', message: 'Instalando piper-tts (pode levar ~1 min)…', done: false });
      await run(
        venvPython(),
        ['-m', 'pip', 'install', 'piper-tts'],
        'Instalação do piper-tts',
        (line) => emit({ stage: 'piper', message: line, done: false }),
      );
    }

    emit({ stage: 'done', message: 'Piper pronto.', done: true });
  } catch (err) {
    emit({
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
      done: true,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ----------------------------- Clonagem (Chatterbox) -----------------------------

export function cloneVenvReady(): boolean {
  return fs.existsSync(cloneVenvPython());
}

/** true se o pacote chatterbox está importável no venv de clonagem. */
export function chatterboxInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!cloneVenvReady()) return resolve(false);
    const p = spawn(cloneVenvPython(), ['-c', 'import chatterbox']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function emitClone(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.cloneSetupProgress, p);
  }
}

/**
 * Cria o venv (Python 3.11) e instala chatterbox-tts (+ PyTorch). Pesado.
 * Idempotente; emite progresso para o renderer.
 */
export async function setupCloneEnv(): Promise<void> {
  try {
    const py = python311();
    if (!py) {
      throw new Error(
        'Python 3.11 não encontrado. Instale com: brew install python@3.11 e tente de novo.',
      );
    }

    if (!cloneVenvReady()) {
      emitClone({ stage: 'venv', message: 'Criando ambiente Python 3.11 isolado…', done: false });
      await run(py, ['-m', 'venv', cloneVenvDir()], 'Criação do venv de clonagem');
    }

    // setuptools<80 é necessário: o resemble-perth (do chatterbox) importa
    // pkg_resources, que não vem nos venvs de Python 3.11 e foi REMOVIDO do
    // setuptools 81+. A versão 79.x ainda o fornece.
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
    emitClone({
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
      done: true,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
