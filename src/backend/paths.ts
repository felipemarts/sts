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

/** Raiz da instalação do whisper.cpp baixada pelo app (binário + libs). */
export function whisperDir(): string {
  return ensureDir(path.join(userDataDir(), 'whisper'));
}

/** Diretório onde o binário whisper.cpp (e DLLs/libs) é extraído. */
export function whisperBinDir(): string {
  return path.join(whisperDir(), 'bin');
}

export function piperVoicesDir(): string {
  return ensureDir(path.join(modelsDir(), 'piper'));
}

/** Diretório do ambiente Python (venv) usado pelo Piper. */
export function pythonDir(): string {
  return ensureDir(path.join(userDataDir(), 'python'));
}

/**
 * Raiz onde o Python 3.11 embutido (python-build-standalone) é extraído.
 * O arquivo `install_only` extrai para uma subpasta `python/`. Esse interpretador
 * é a base tanto do venv do Piper quanto do venv da clonagem — o app não depende
 * de nenhum Python instalado no sistema.
 */
export function embeddedPythonRoot(): string {
  return path.join(pythonDir(), 'runtime');
}

/** Caminho do interpretador Python embutido (posix/win). */
export function embeddedPython(): string {
  return process.platform === 'win32'
    ? path.join(embeddedPythonRoot(), 'python', 'python.exe')
    : path.join(embeddedPythonRoot(), 'python', 'bin', 'python3');
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

// --- Modo de clonagem de voz (venv Python 3.11 pesado + cache de modelos) ---

export function cloneDir(): string {
  return ensureDir(path.join(userDataDir(), 'clone'));
}

export function cloneVenvDir(): string {
  return path.join(cloneDir(), 'venv');
}

export function cloneVenvPython(): string {
  return process.platform === 'win32'
    ? path.join(cloneVenvDir(), 'Scripts', 'python.exe')
    : path.join(cloneVenvDir(), 'bin', 'python');
}

/** WAV de referência atual da clonagem (a amostra gravada pelo microfone). */
export function cloneRefPath(): string {
  return path.join(cloneDir(), 'reference.wav');
}

/** Cache do HuggingFace para os modelos de clonagem (fora de ~/.cache). */
export function hfCacheDir(): string {
  return ensureDir(path.join(cloneDir(), 'hf-cache'));
}

/** Script do worker Python de clonagem, escrito em runtime. */
export function cloneWorkerPath(): string {
  return path.join(cloneDir(), 'clone_worker.py');
}
