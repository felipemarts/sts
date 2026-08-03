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
    setup: () => ipcRenderer.invoke(IPC.whisperSetup),
    onSetupProgress: (cb) => subscribe<SetupProgress>(IPC.whisperSetupProgress, cb),
  },
  tts: {
    voices: () => ipcRenderer.invoke(IPC.ttsVoices),
    synth: (text, engine, voice, rate) =>
      ipcRenderer.invoke(IPC.ttsSynth, text, engine, voice, rate),
    export: (text, engine, voice, rate) =>
      ipcRenderer.invoke(IPC.ttsExport, text, engine, voice, rate),
  },
  piper: {
    ensure: () => ipcRenderer.invoke(IPC.piperEnsure),
    setup: () => ipcRenderer.invoke(IPC.piperSetup),
    onSetupProgress: (cb) => subscribe<SetupProgress>(IPC.piperSetupProgress, cb),
  },
  clone: {
    ensure: () => ipcRenderer.invoke(IPC.cloneEnsure),
    setup: () => ipcRenderer.invoke(IPC.cloneSetup),
    onSetupProgress: (cb) => subscribe<SetupProgress>(IPC.cloneSetupProgress, cb),
    saveReference: (pcm, sampleRate) =>
      ipcRenderer.invoke(IPC.cloneSaveReference, pcm, sampleRate),
    synth: (text, language) => ipcRenderer.invoke(IPC.cloneSynth, text, language),
    synthSegment: (text, language) => ipcRenderer.invoke(IPC.cloneSynthSegment, text, language),
    stop: () => ipcRenderer.invoke(IPC.cloneStop),
    export: (text, language) => ipcRenderer.invoke(IPC.cloneExport, text, language),
  },
  engines: {
    status: () => ipcRenderer.invoke(IPC.enginesStatus),
  },
  saveText: (text, suggestedName) => ipcRenderer.invoke(IPC.saveText, text, suggestedName),
  copyText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
  saveAudio: (bytes, suggestedName) => ipcRenderer.invoke(IPC.saveAudio, bytes, suggestedName),
  saveWavFromPcm: (pcm, sampleRate, suggestedName) =>
    ipcRenderer.invoke(IPC.saveWavFromPcm, pcm, sampleRate, suggestedName),
};

contextBridge.exposeInMainWorld('sts', api);
