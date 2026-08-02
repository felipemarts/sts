import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC, DownloadProgress, SetupProgress } from './shared/types';
import { StsApi } from './shared/api';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: StsApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  },
  catalog: () => ipcRenderer.invoke(IPC.catalogGet),
  models: {
    status: () => ipcRenderer.invoke(IPC.modelsStatus),
    download: (kind, id) => ipcRenderer.invoke(IPC.modelDownload, kind, id),
    remove: (kind, id) => ipcRenderer.invoke(IPC.modelRemove, kind, id),
    onProgress: (cb) => subscribe<DownloadProgress>(IPC.modelProgress, cb),
  },
  whisper: {
    transcribe: (pcm, sampleRate, language) =>
      ipcRenderer.invoke(IPC.whisperTranscribe, pcm, sampleRate, language),
    stop: () => ipcRenderer.invoke(IPC.whisperStop),
  },
  piper: {
    ensure: () => ipcRenderer.invoke(IPC.piperEnsure),
    setup: () => ipcRenderer.invoke(IPC.piperSetup),
    onSetupProgress: (cb) => subscribe<SetupProgress>(IPC.piperSetupProgress, cb),
    synth: (text, voiceId, rate) =>
      ipcRenderer.invoke(IPC.piperSynth, text, voiceId, rate),
    export: (text, voiceId, rate) =>
      ipcRenderer.invoke(IPC.ttsExport, text, voiceId, rate),
  },
  engines: {
    status: () => ipcRenderer.invoke(IPC.enginesStatus),
  },
};

contextBridge.exposeInMainWorld('sts', api);
