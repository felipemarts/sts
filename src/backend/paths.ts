import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Todos os artefatos pesados (modelos, vozes, venv do Piper) ficam na pasta
 * userData do app — NUNCA dentro do repositório. Isso mantém o repo limpo e
 * pronto para virar open source.
 */
export function userDataDir(): string {
  return app.getPath('userData');
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function modelsDir(): string {
  return ensureDir(path.join(userDataDir(), 'models'));
}

export function whisperModelsDir(): string {
  return ensureDir(path.join(modelsDir(), 'whisper'));
}

export function piperVoicesDir(): string {
  return ensureDir(path.join(modelsDir(), 'piper'));
}

/** Diretório do ambiente Python (venv) usado pelo Piper. */
export function pythonDir(): string {
  return ensureDir(path.join(userDataDir(), 'python'));
}

export function venvDir(): string {
  return path.join(pythonDir(), 'venv');
}

/** Caminho do python dentro do venv (posix/win). */
export function venvPython(): string {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python');
}

export function settingsFile(): string {
  return path.join(userDataDir(), 'settings.json');
}

export function tmpDir(): string {
  return ensureDir(path.join(userDataDir(), 'tmp'));
}
