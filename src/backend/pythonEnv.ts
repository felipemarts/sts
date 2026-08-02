import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../shared/types';
import { venvDir, venvPython } from './paths';
import { resolveBinary } from './util';

/** Localiza um python3 do sistema para criar o venv. */
export function systemPython(): string | null {
  return resolveBinary('python3') || resolveBinary('python');
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
