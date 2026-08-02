// Tipos compartilhados entre main process, preload e renderer.

export type ModelKind = 'whisper' | 'piper';

export interface WhisperModel {
  id: string;
  label: string;
  /** Tamanho aproximado em bytes (para exibir e para progresso). */
  sizeBytes: number;
  url: string;
  /** Nome do arquivo salvo em models/whisper. */
  file: string;
  multilingual: boolean;
  note?: string;
}

export interface PiperVoice {
  id: string;
  label: string;
  language: string; // ex: "pt_BR"
  quality: string; // ex: "medium"
  sizeBytes: number;
  onnxUrl: string;
  configUrl: string;
  /** Nome base do arquivo salvo em models/piper (sem extensão). */
  file: string;
}

export interface Catalog {
  whisper: WhisperModel[];
  piper: PiperVoice[];
}

/** Status "instalado ou não" por id de modelo. */
export type InstallStatus = Record<string, boolean>;

export interface DownloadProgress {
  kind: ModelKind;
  id: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error?: string;
}

export interface Settings {
  micDeviceId: string | null;
  whisperModel: string | null;
  whisperLanguage: string; // "auto" | "pt" | "en" | ...
  whisperServerPath: string | null; // override manual do binário
  piperVoice: string | null;
  ttsRate: number; // 0.5 (lento) .. 2.0 (rápido); vira length_scale = 1/rate
  ttsVolume: number; // 0..1 (ganho no playback)
  vadThreshold: number; // limiar de energia RMS (0..1)
  vadHangoverMs: number; // silêncio para encerrar um segmento de fala
  cloneLanguage: string; // idioma da síntese clonada (ex.: "pt")
  cloneRefPath: string | null; // WAV de referência atual (amostra gravada)
}

export interface EngineStatus {
  whisper: {
    binaryPath: string | null;
    available: boolean;
    running: boolean;
    model: string | null;
  };
  piper: {
    venvReady: boolean;
    pythonPath: string | null;
    available: boolean; // python3 do sistema encontrado
  };
}

export interface SetupProgress {
  stage: string;
  message: string;
  done: boolean;
  error?: string;
}

// Canais de IPC (mantidos como constantes para evitar typos).
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  catalogGet: 'catalog:get',
  modelsStatus: 'models:status',
  modelDownload: 'model:download',
  modelRemove: 'model:remove',
  modelProgress: 'model:progress', // evento main -> renderer
  whisperTranscribe: 'whisper:transcribe',
  whisperStop: 'whisper:stop',
  piperEnsure: 'piper:ensure',
  piperSetup: 'piper:setup',
  piperSetupProgress: 'piper:setup:progress', // evento main -> renderer
  piperSynth: 'piper:synth',
  ttsExport: 'tts:export',
  cloneEnsure: 'clone:ensure',
  cloneSetup: 'clone:setup',
  cloneSetupProgress: 'clone:setup:progress', // evento main -> renderer
  cloneSaveReference: 'clone:saveReference',
  cloneSynth: 'clone:synth',
  cloneExport: 'clone:export',
  enginesStatus: 'engines:status',
} as const;
