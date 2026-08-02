import { ipcMain, dialog, BrowserWindow } from 'electron';
import {
  EngineStatus,
  IPC,
  ModelKind,
  Settings,
} from '../shared/types';
import { ExportResult } from '../shared/api';
import { writeAudio } from './audioExport';
import { getSettings, setSettings } from './settings';
import { getCatalog, findWhisper, findVoice } from './models/catalog';
import {
  downloadModel,
  installStatus,
  removeModel,
  whisperModelPath,
} from './models/manager';
import { transcribe, stopServer, whisperStatus } from './engines/whisper';
import { synth } from './engines/piper';
import { setupPiperEnv, systemPython, venvReady, piperInstalled } from './pythonEnv';
import { venvPython } from './paths';

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
  ipcMain.handle(IPC.whisperStop, () => stopServer());

  ipcMain.handle(IPC.piperEnsure, async () => ({
    systemPython: systemPython(),
    venvReady: venvReady(),
    piperInstalled: await piperInstalled(),
  }));
  ipcMain.handle(IPC.piperSetup, () => setupPiperEnv());
  ipcMain.handle(
    IPC.piperSynth,
    async (_e, text: string, voiceId: string, rate: number) => {
      const buf = await synth(text, voiceId, { rate });
      return buf; // vira Uint8Array no renderer
    },
  );

  ipcMain.handle(
    IPC.ttsExport,
    async (e, text: string, voiceId: string, rate: number): Promise<ExportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const voice = findVoice(voiceId);
      const base = (voice?.language ? `fala-${voice.language}` : 'fala').replace(/[^\w-]/g, '');
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Salvar áudio',
        defaultPath: `${base}.mp3`,
        filters: [
          { name: 'MP3', extensions: ['mp3'] },
          { name: 'WAV', extensions: ['wav'] },
        ],
      });
      if (canceled || !filePath) return { canceled: true };
      const wav = await synth(text, voiceId, { rate });
      await writeAudio(wav, filePath);
      return { canceled: false, path: filePath };
    },
  );

  ipcMain.handle(IPC.enginesStatus, async (): Promise<EngineStatus> => {
    return {
      whisper: whisperStatus(),
      piper: {
        venvReady: venvReady(),
        pythonPath: venvReady() ? venvPython() : null,
        available: !!systemPython(),
      },
    };
  });
}
