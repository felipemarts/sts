import { ipcMain, dialog, BrowserWindow, clipboard } from 'electron';
import fs from 'node:fs';
import {
  EngineStatus,
  IPC,
  ModelKind,
  Settings,
  TtsEngine,
} from '../shared/types';
import { ExportResult, CloneEnsure, PiperEnsure } from '../shared/api';
import { writeAudio } from './audioExport';
import { encodeWav } from './util';
import { getSettings, setSettings } from './settings';
import { getCatalog, findWhisper, findVoice } from './models/catalog';
import {
  downloadModel,
  installStatus,
  removeModel,
  whisperModelPath,
} from './models/manager';
import {
  transcribe,
  stopWhisper,
  whisperStatus,
  installWhisperBinary,
} from './engines/whisper';
import { synth } from './engines/piper';
import { synthEdge, listEdgeVoices } from './engines/edgeTts';
import { synthClone, synthSegment, stopWorker as stopClone } from './engines/voiceClone';
import {
  setupPiperEnv,
  venvReady,
  piperInstalled,
  setupCloneEnv,
  pythonRuntimeReady,
  cloneVenvReady,
  chatterboxInstalled,
} from './pythonEnv';
import { cloneRefPath } from './paths';

/** Sintetiza um WAV/MP3 com o motor escolhido. Retorna os bytes. */
async function synthWithEngine(
  text: string,
  engine: TtsEngine,
  voice: string,
  rate: number,
): Promise<Buffer> {
  if (engine === 'edge') return synthEdge(text, { voice, rate });
  return synth(text, voice, { rate }); // piper
}

export function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => setSettings(patch));

  ipcMain.handle(IPC.catalogGet, () => getCatalog());
  ipcMain.handle(IPC.modelsStatus, () => installStatus());
  ipcMain.handle(IPC.modelDownload, (_e, kind: ModelKind, id: string) =>
    downloadModel(kind, id),
  );
  ipcMain.handle(IPC.modelRemove, (_e, kind: ModelKind, id: string) => {
    removeModel(kind, id);
  });

  // ------------------------------- Whisper (STT) -------------------------------

  ipcMain.handle(
    IPC.whisperTranscribe,
    async (_e, pcm: ArrayBuffer, sampleRate: number, language?: string) => {
      const s = getSettings();
      const model = s.whisperModel ? findWhisper(s.whisperModel) : undefined;
      if (!model) throw new Error('Nenhum modelo Whisper selecionado.');
      const modelPath = whisperModelPath(model.file);
      const samples = new Float32Array(pcm);
      return transcribe(modelPath, samples, sampleRate, language ?? s.whisperLanguage);
    },
  );
  ipcMain.handle(IPC.whisperStop, () => stopWhisper());
  ipcMain.handle(IPC.whisperSetup, () => installWhisperBinary());

  // Salva um texto (ex.: transcrição) num .txt escolhido pelo usuário.
  ipcMain.handle(
    IPC.saveText,
    async (e, text: string, suggestedName: string): Promise<ExportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Salvar transcrição',
        defaultPath: suggestedName,
        filters: [{ name: 'Texto', extensions: ['txt'] }],
      });
      if (canceled || !filePath) return { canceled: true };
      fs.writeFileSync(filePath, text, 'utf8');
      return { canceled: false, path: filePath };
    },
  );

  // Salva bytes de áudio já gerados (evita re-sintetizar ao exportar).
  ipcMain.handle(
    IPC.saveAudio,
    async (e, bytes: ArrayBuffer, suggestedName: string): Promise<ExportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Salvar áudio',
        defaultPath: suggestedName,
        filters: [
          { name: 'WAV', extensions: ['wav'] },
          { name: 'MP3', extensions: ['mp3'] },
        ],
      });
      if (canceled || !filePath) return { canceled: true };
      await writeAudio(Buffer.from(new Uint8Array(bytes)), filePath);
      return { canceled: false, path: filePath };
    },
  );

  // Salva PCM float32 (ex.: segmentos concatenados) como WAV/MP3 escolhido.
  ipcMain.handle(
    IPC.saveWavFromPcm,
    async (
      e,
      pcm: ArrayBuffer,
      sampleRate: number,
      suggestedName: string,
    ): Promise<ExportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Salvar áudio',
        defaultPath: suggestedName,
        filters: [
          { name: 'WAV', extensions: ['wav'] },
          { name: 'MP3', extensions: ['mp3'] },
        ],
      });
      if (canceled || !filePath) return { canceled: true };
      await writeAudio(encodeWav(new Float32Array(pcm), sampleRate), filePath);
      return { canceled: false, path: filePath };
    },
  );

  // Copia para a área de transferência via módulo nativo (o navigator.clipboard
  // do renderer falha no Electron com "permission denied" sem foco/permissão).
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => {
    clipboard.writeText(text ?? '');
  });

  // ------------------------------- TTS (Ler) -------------------------------

  ipcMain.handle(IPC.ttsVoices, () => listEdgeVoices());

  ipcMain.handle(
    IPC.ttsSynth,
    async (_e, text: string, engine: TtsEngine, voice: string, rate: number) => {
      const buf = await synthWithEngine(text, engine, voice, rate);
      return buf; // vira Uint8Array no renderer
    },
  );

  ipcMain.handle(
    IPC.ttsExport,
    async (
      e,
      text: string,
      engine: TtsEngine,
      voice: string,
      rate: number,
    ): Promise<ExportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const base =
        engine === 'piper'
          ? (findVoice(voice)?.language ? `fala-${findVoice(voice)!.language}` : 'fala')
          : `fala-${voice}`;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Salvar áudio',
        defaultPath: `${base.replace(/[^\w-]/g, '')}.mp3`,
        filters: [
          { name: 'MP3', extensions: ['mp3'] },
          { name: 'WAV', extensions: ['wav'] },
        ],
      });
      if (canceled || !filePath) return { canceled: true };
      const buf = await synthWithEngine(text, engine, voice, rate);
      await writeAudio(buf, filePath);
      return { canceled: false, path: filePath };
    },
  );

  // ------------------------------- Piper (setup local) -------------------------------

  ipcMain.handle(IPC.piperEnsure, async (): Promise<PiperEnsure> => ({
    pythonRuntimeReady: pythonRuntimeReady(),
    venvReady: venvReady(),
    piperInstalled: await piperInstalled(),
  }));
  ipcMain.handle(IPC.piperSetup, () => setupPiperEnv());

  // ------------------------------- Clonagem de voz -------------------------------

  ipcMain.handle(IPC.cloneEnsure, async (): Promise<CloneEnsure> => ({
    pythonRuntimeReady: pythonRuntimeReady(),
    venvReady: cloneVenvReady(),
    installed: await chatterboxInstalled(),
    hasReference: fs.existsSync(cloneRefPath()),
  }));

  ipcMain.handle(IPC.cloneSetup, () => setupCloneEnv());

  ipcMain.handle(
    IPC.cloneSaveReference,
    (_e, pcm: ArrayBuffer, sampleRate: number): string => {
      const wav = encodeWav(new Float32Array(pcm), sampleRate);
      const dest = cloneRefPath();
      fs.writeFileSync(dest, wav);
      setSettings({ cloneRefPath: dest });
      return dest;
    },
  );

  ipcMain.handle(IPC.cloneSynth, async (_e, text: string, language: string) => {
    return synthClone(text, language); // vira Uint8Array no renderer
  });

  ipcMain.handle(IPC.cloneSynthSegment, async (_e, text: string, language: string) => {
    return synthSegment(text, language); // uma frase, via pool
  });
  ipcMain.handle(IPC.cloneStop, () => stopClone());

  ipcMain.handle(
    IPC.cloneExport,
    async (e, text: string, language: string): Promise<ExportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Salvar áudio (voz clonada)',
        defaultPath: 'voz-clonada.mp3',
        filters: [
          { name: 'MP3', extensions: ['mp3'] },
          { name: 'WAV', extensions: ['wav'] },
        ],
      });
      if (canceled || !filePath) return { canceled: true };
      const wav = await synthClone(text, language);
      await writeAudio(wav, filePath);
      return { canceled: false, path: filePath };
    },
  );

  ipcMain.handle(IPC.enginesStatus, async (): Promise<EngineStatus> => ({
    whisper: whisperStatus(),
  }));
}
