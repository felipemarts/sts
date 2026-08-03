/**
 * STT local via whisper.cpp (modo CLI, autoinstalável).
 *
 * Diferente da versão antiga (que exigia um `whisper-server` já instalado no
 * sistema), aqui o binário do whisper.cpp é BAIXADO pelo próprio app para a
 * pasta userData — exatamente a abordagem dos projetos `agent`/`ditador`, que
 * funcionam sem nenhuma instalação manual:
 *
 *   - Windows / Linux: baixa o binário da release oficial do whisper.cpp.
 *   - macOS: não há binário CLI oficial nas releases; usa o `whisper-cli` do
 *     Homebrew (`brew install whisper-cpp`) ou um caminho definido nas
 *     Configurações.
 *
 * A transcrição roda o CLI uma vez por segmento de fala (o renderer recorta a
 * fala por VAD e manda o PCM). Simples e sem servidor/porta/HTTP — menos pontos
 * de falha em máquinas com antivírus/firewall restritivos.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import { IPC, SetupProgress } from '../../shared/types';
import { getSettings } from '../settings';
import { whisperBinDir, whisperDir, tmpDir } from '../paths';
import {
  resolveBinary,
  encodeWav,
  downloadFile,
  extractArchive,
  findLatestReleaseAsset,
  unblockDownloadedFiles,
} from '../util';

const WHISPER_REPO = 'ggml-org/whisper.cpp';

let installing = false;
const activeChildren = new Set<ChildProcess>();

/** Nome do executável de transcrição por plataforma. */
function cliName(): string {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}
function legacyName(): string {
  return process.platform === 'win32' ? 'main.exe' : 'main';
}

/** Procura, recursivamente, o executável do whisper.cpp dentro de `root`. */
function findBinaryIn(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  let legacy: string | null = null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (name === cliName()) return p;
      else if (name === legacyName()) legacy = p; // main é stub deprecado; só se não houver whisper-cli
    }
  }
  return legacy;
}

function findDownloadedBinary(): string | null {
  return findBinaryIn(whisperBinDir());
}

/**
 * Instalações de whisper.cpp de OUTROS apps do usuário que já rodam nesta
 * máquina (ex.: o projeto `agent`/jarvis-desktop). Reaproveitá-las evita
 * rebaixar o binário e — no Windows — usa uma cópia que o usuário já liberou no
 * SmartScreen/Defender, em vez de disparar o aviso "editor desconhecido".
 */
function externalWhisperBinDirs(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(path.join(app.getPath('appData'), 'jarvis-desktop', 'whisper', 'bin'));
  } catch {
    /* ignore */
  }
  return dirs;
}

/** Binário: override → instalação externa validada → baixado → sistema (brew). */
export function whisperBinary(): string | null {
  const override = getSettings().whisperServerPath;
  if (override && fs.existsSync(override)) return override;
  for (const dir of externalWhisperBinDirs()) {
    const bin = findBinaryIn(dir);
    if (bin) return bin;
  }
  const downloaded = findDownloadedBinary();
  if (downloaded) return downloaded;
  // Sistema (macOS via brew, ou qualquer PATH): tenta os nomes conhecidos.
  return (
    resolveBinary('whisper-cli') ||
    resolveBinary('whisper-cpp') ||
    resolveBinary('main')
  );
}

/** true se a plataforma tem binário baixável automaticamente pelo app. */
export function canAutoInstall(): boolean {
  return process.platform === 'win32' || process.platform === 'linux';
}

export function whisperStatus() {
  const bin = whisperBinary();
  return {
    binaryPath: bin,
    available: !!bin,
    installing,
    canAutoInstall: canAutoInstall(),
    platform: process.platform,
  };
}

function emitProgress(p: SetupProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.whisperSetupProgress, p);
  }
}

/** Escolhe o asset da release do whisper.cpp para esta plataforma. */
function pickBinaryAsset(name: string): boolean {
  const n = name.toLowerCase();
  if (process.platform === 'win32') {
    // BLAS acelerado, x64 (roda também no Windows ARM via emulação).
    return n.includes('blas') && n.includes('x64') && n.endsWith('.zip') &&
      !n.includes('win32') && !n.includes('cublas');
  }
  if (process.platform === 'linux') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return n.includes('ubuntu') && n.includes(arch) && n.endsWith('.tar.gz');
  }
  return false;
}

/**
 * Baixa e extrai o binário do whisper.cpp (Windows/Linux). Idempotente.
 * Emite progresso para o renderer. Em macOS lança erro com orientação.
 */
export async function installWhisperBinary(): Promise<void> {
  if (whisperBinary()) return; // já há binário utilizável (baixado, externo ou do sistema)
  if (installing) throw new Error('Instalação do Whisper já em andamento.');
  if (!canAutoInstall()) {
    throw new Error(
      'No macOS o binário do whisper.cpp não é baixado automaticamente. ' +
        'Instale com "brew install whisper-cpp" (ou defina o caminho do binário nas Configurações).',
    );
  }
  installing = true;
  try {
    emitProgress({ stage: 'binary', message: 'Procurando a release do whisper.cpp…', done: false });
    const asset = await findLatestReleaseAsset(WHISPER_REPO, pickBinaryAsset);
    if (!asset) {
      throw new Error('Não encontrei um binário do whisper.cpp para esta plataforma na última release.');
    }

    const archive = path.join(whisperDir(), asset.name);
    emitProgress({ stage: 'binary', message: `Baixando ${asset.name}…`, done: false });
    await downloadFile(asset.browser_download_url, archive, (r, t) => {
      const pct = t ? Math.floor((r / t) * 100) : 0;
      emitProgress({ stage: 'binary', message: `Baixando o binário — ${pct}%`, done: false });
    });

    emitProgress({ stage: 'extract', message: 'Extraindo o binário…', done: false });
    fs.rmSync(whisperBinDir(), { recursive: true, force: true });
    await extractArchive(archive, whisperBinDir());
    fs.rmSync(archive, { force: true });

    const bin = findDownloadedBinary();
    if (!bin) throw new Error('Executável não encontrado após extrair o pacote.');
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(bin, 0o755);
      } catch {
        /* ignore */
      }
    }
    await unblockDownloadedFiles(whisperBinDir()); // tira o Mark of the Web (Windows)
    emitProgress({ stage: 'done', message: 'Whisper pronto.', done: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitProgress({ stage: 'error', message: msg, done: true, error: msg });
    throw err;
  } finally {
    installing = false;
  }
}

/** Remove ruídos típicos do Whisper ([BLANK_AUDIO], (música), ♪, etc). */
function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/♪/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Transcreve um segmento de PCM float32 mono. Retorna o texto.
 * Roda o whisper-cli uma vez, escrevendo o áudio num WAV temporário.
 */
export async function transcribe(
  modelPath: string,
  pcm: Float32Array,
  sampleRate: number,
  language: string,
): Promise<string> {
  const bin = whisperBinary();
  if (!bin) {
    throw new Error(
      canAutoInstall()
        ? 'whisper.cpp ainda não instalado. Vá em Configurações e clique em "Instalar Whisper".'
        : 'whisper.cpp não encontrado. Instale com "brew install whisper-cpp" ou defina o caminho nas Configurações.',
    );
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error('Modelo Whisper selecionado não está baixado.');
  }

  const wavPath = path.join(tmpDir(), `stt-${process.hrtime.bigint()}.wav`);
  fs.writeFileSync(wavPath, encodeWav(pcm, sampleRate));

  const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
  const lang = language && language !== 'auto' ? language : 'auto';
  // -bs 1 -bo 1 = greedy: ~5x mais rápido que beam search, qualidade equivalente para fala.
  const args = [
    '-m', modelPath, '-f', wavPath, '-l', lang,
    '-nt', '-t', String(threads), '-bs', '1', '-bo', '1',
  ];

  const binDir = path.dirname(bin);
  const env = { ...process.env };
  if (process.platform === 'linux') {
    // O tarball do Linux traz as .so junto do binário.
    env.LD_LIBRARY_PATH = `${binDir}${path.delimiter}${env.LD_LIBRARY_PATH ?? ''}`;
  }

  try {
    return await new Promise<string>((resolve, reject) => {
      const p = spawn(bin, args, { windowsHide: true, cwd: binDir, env });
      activeChildren.add(p);
      let out = '';
      let err = '';
      p.stdout?.on('data', (c) => (out += c));
      p.stderr?.on('data', (c) => (err += c));
      p.on('error', reject);
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('Whisper: timeout de 120s na transcrição.'));
      }, 120_000);
      p.on('exit', (code) => {
        clearTimeout(timer);
        activeChildren.delete(p);
        if (code === 0) resolve(cleanTranscript(out));
        // Cancelado ao parar a captura (killed por sinal → code null): não é erro.
        else if (code === null && (p as ChildProcess & { __stopped?: boolean }).__stopped) resolve('');
        else reject(new Error(`whisper saiu com código ${code}: ${err.slice(-300)}`));
      });
    });
  } finally {
    fs.rm(wavPath, { force: true }, () => {});
  }
}

/** Cancela qualquer transcrição em andamento (chamado ao parar a captura). */
export function stopWhisper(): void {
  for (const p of activeChildren) {
    (p as ChildProcess & { __stopped?: boolean }).__stopped = true;
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
}
