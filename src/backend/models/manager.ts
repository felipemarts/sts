import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import {
  DownloadProgress,
  InstallStatus,
  IPC,
  ModelKind,
} from '../../shared/types';
import { whisperModelsDir, piperVoicesDir } from '../paths';
import { downloadFile } from '../util';
import { findVoice, findWhisper, getCatalog } from './catalog';

export function whisperModelPath(file: string): string {
  return path.join(whisperModelsDir(), file);
}

export function voiceOnnxPath(file: string): string {
  return path.join(piperVoicesDir(), file + '.onnx');
}

export function voiceConfigPath(file: string): string {
  return path.join(piperVoicesDir(), file + '.onnx.json');
}

/** Retorna, por id, se cada modelo/voz do catálogo está instalado. */
export function installStatus(): InstallStatus {
  const status: InstallStatus = {};
  const cat = getCatalog();
  for (const m of cat.whisper) {
    status[m.id] = fs.existsSync(whisperModelPath(m.file));
  }
  for (const v of cat.piper) {
    status[v.id] =
      fs.existsSync(voiceOnnxPath(v.file)) && fs.existsSync(voiceConfigPath(v.file));
  }
  return status;
}

function emitProgress(p: DownloadProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.modelProgress, p);
  }
}

export async function downloadModel(kind: ModelKind, id: string): Promise<void> {
  try {
    if (kind === 'whisper') {
      const m = findWhisper(id);
      if (!m) throw new Error(`Modelo whisper desconhecido: ${id}`);
      await downloadFile(m.url, whisperModelPath(m.file), (r, t) =>
        emitProgress({ kind, id, receivedBytes: r, totalBytes: t || m.sizeBytes, done: false }),
      );
    } else {
      const v = findVoice(id);
      if (!v) throw new Error(`Voz piper desconhecida: ${id}`);
      // Baixa o config (pequeno) e depois o modelo (grande), com progresso do onnx.
      await downloadFile(v.configUrl, voiceConfigPath(v.file));
      await downloadFile(v.onnxUrl, voiceOnnxPath(v.file), (r, t) =>
        emitProgress({ kind, id, receivedBytes: r, totalBytes: t || v.sizeBytes, done: false }),
      );
    }
    emitProgress({ kind, id, receivedBytes: 1, totalBytes: 1, done: true });
  } catch (err) {
    emitProgress({
      kind,
      id,
      receivedBytes: 0,
      totalBytes: 0,
      done: true,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function removeModel(kind: ModelKind, id: string): void {
  const rm = (p: string) => {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  };
  if (kind === 'whisper') {
    const m = findWhisper(id);
    if (m) rm(whisperModelPath(m.file));
  } else {
    const v = findVoice(id);
    if (v) {
      rm(voiceOnnxPath(v.file));
      rm(voiceConfigPath(v.file));
    }
  }
}
