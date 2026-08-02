import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveBinary } from './util';

export function ffmpegBinary(): string | null {
  return resolveBinary('ffmpeg');
}

/** Converte um buffer WAV em MP3 gravado em outPath, via ffmpeg (libmp3lame). */
export function wavBufferToMp3File(
  wav: Buffer,
  outPath: string,
  bitrate = '192k',
): Promise<void> {
  const ff = ffmpegBinary();
  if (!ff) {
    throw new Error(
      'ffmpeg não encontrado. Instale com: brew install ffmpeg (necessário para exportar MP3).',
    );
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(ff, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'wav',
      '-i', 'pipe:0',
      '-codec:a', 'libmp3lame',
      '-b:a', bitrate,
      outPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg falhou (código ${code}): ${stderr.slice(-500)}`));
    });
    proc.stdin.on('error', () => {
      /* ignora EPIPE se o ffmpeg fechar cedo */
    });
    proc.stdin.write(wav);
    proc.stdin.end();
  });
}

/** Grava o áudio no caminho escolhido, decidindo o formato pela extensão. */
export async function writeAudio(wav: Buffer, outPath: string): Promise<void> {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.wav') {
    fs.writeFileSync(outPath, wav);
  } else {
    await wavBufferToMp3File(wav, outPath);
  }
}
