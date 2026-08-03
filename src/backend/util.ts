import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

/**
 * Resolve o caminho de um binário procurando: caminho explícito (override),
 * locais comuns e o PATH do processo. Retorna null se não encontrar.
 * Sem caminhos pessoais hardcoded — tudo derivado do ambiente.
 */
export function resolveBinary(name: string, override?: string | null): string | null {
  if (override && fs.existsSync(override)) return override;

  const commonDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const winExt = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];

  for (const dir of [...commonDirs, ...pathDirs]) {
    for (const ext of winExt) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* continua */
      }
    }
  }
  return null;
}

/** Encontra uma porta TCP livre no loopback. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Codifica PCM float32 mono em um buffer WAV 16-bit PCM.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    buffer.writeInt16LE(s | 0, offset);
    offset += 2;
  }
  return buffer;
}

/**
 * Baixa uma URL para um arquivo, reportando progresso. Usa fetch nativo do Node 20.
 * Grava primeiro em .part e renomeia ao final (download atômico).
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download falhou (${res.status}) para ${url}`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  const partPath = dest + '.part';
  const out = fs.createWriteStream(partPath);
  let received = 0;

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', () => r()));
      }
      if (onProgress) onProgress(received, total);
    }
  } finally {
    out.end();
  }
  await new Promise<void>((r, j) => {
    out.on('finish', () => r());
    out.on('error', j);
  });
  fs.renameSync(partPath, dest);
}

/**
 * Extrai um arquivo (.zip ou .tar.gz) para destDir usando o `tar` do sistema.
 * - Windows: o bsdtar embutido (Win10+) lê tanto .zip quanto .tar.gz.
 * - macOS: o tar (bsdtar) também lê ambos.
 * - Linux: o GNU tar lê .tar.gz nativamente (só baixamos .tar.gz no Linux).
 * `-xf` detecta a compressão automaticamente.
 */
export function extractArchive(archivePath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  // No Windows, invoca o bsdtar do sistema (System32) por caminho absoluto: o
  // `tar` do PATH pode ser o GNU tar (Git for Windows), que (a) não lê .zip e
  // (b) trata "C:\…" como host remoto ("tar: Cannot connect to C: resolve failed").
  const tarBin =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  return new Promise((resolve, reject) => {
    const p = spawn(tarBin, ['-xf', archivePath, '-C', destDir], { windowsHide: true });
    let err = '';
    p.stderr?.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Falha ao extrair (${code}): ${err.slice(0, 300)}`));
    });
  });
}

/**
 * Remove o "Mark of the Web" dos arquivos extraídos (Windows). Sem isso, o
 * SmartScreen/Defender pode bloquear binários/DLLs baixados ("editor
 * desconhecido"). Não-fatal — resolve mesmo se falhar.
 */
export function unblockDownloadedFiles(dir: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-ChildItem -LiteralPath '${dir}' -Recurse -File | Unblock-File`,
      ],
      { windowsHide: true },
    );
    ps.on('error', () => resolve());
    ps.on('exit', () => resolve());
  });
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/**
 * Consulta a última release de um repositório no GitHub e retorna o primeiro
 * asset cujo nome satisfaz o predicado. Consultar em runtime evita fixar uma
 * versão que quebra quando os autores publicam uma nova release.
 */
export async function findLatestReleaseAsset(
  repo: string,
  match: (name: string) => boolean,
): Promise<ReleaseAsset | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sts-app' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} para ${repo}`);
  const data = (await res.json()) as { assets?: ReleaseAsset[] };
  return data.assets?.find((a) => match(a.name)) ?? null;
}
