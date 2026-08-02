import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { venvPython } from '../paths';
import { tmpDir } from '../paths';
import { piperVoicesDir } from '../paths';
import { findVoice } from '../models/catalog';
import { voiceConfigPath, voiceOnnxPath } from '../models/manager';

export interface SynthOptions {
  /** 0.5 (lento) .. 2.0 (rápido). Convertido para length_scale = 1/rate. */
  rate: number;
}

let counter = 0;

/**
 * Sintetiza `text` com a voz `voiceId`, retornando os bytes de um WAV.
 * A velocidade é aplicada no length_scale do Piper (preserva o tom).
 * O volume é controlado no playback (renderer), então aqui é sempre 1.0.
 */
export async function synth(
  text: string,
  voiceId: string,
  opts: SynthOptions,
): Promise<Buffer> {
  const voice = findVoice(voiceId);
  if (!voice) throw new Error(`Voz desconhecida: ${voiceId}`);

  const onnx = voiceOnnxPath(voice.file);
  const config = voiceConfigPath(voice.file);
  if (!fs.existsSync(onnx) || !fs.existsSync(config)) {
    throw new Error(`Voz "${voice.label}" não está baixada.`);
  }

  const lengthScale = 1 / Math.max(0.25, Math.min(4, opts.rate));
  const outPath = path.join(tmpDir(), `tts_${process.pid}_${counter++}.wav`);

  const args = [
    '-m', 'piper',
    '-m', onnx,
    '-c', config,
    '--data-dir', piperVoicesDir(),
    '--length-scale', String(lengthScale),
    '-f', outPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(venvPython(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Piper falhou (código ${code}): ${stderr.slice(-500)}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });

  const buf = fs.readFileSync(outPath);
  fs.rmSync(outPath, { force: true });
  return buf;
}
