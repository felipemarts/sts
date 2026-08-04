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

/** Voz neural do Edge TTS (online, sem instalação). */
export interface EdgeVoice {
  shortName: string; // ex: "pt-BR-FranciscaNeural"
  locale: string; // ex: "pt-BR"
  gender: string; // "Female" | "Male"
  friendlyName: string;
}

/** Motor de leitura (TTS). */
export type TtsEngine = 'edge' | 'piper';

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
  whisperServerPath: string | null; // override manual do caminho do binário whisper.cpp
  ttsEngine: TtsEngine; // "edge" (padrão, online) | "piper" (local)
  edgeVoice: string | null; // shortName da voz Edge selecionada
  piperVoice: string | null;
  ttsRate: number; // 0.5 (lento) .. 2.0 (rápido); vira length_scale = 1/rate no Piper
  ttsVolume: number; // 0..1 (ganho no playback)
  vadThreshold: number; // limiar de energia RMS (0..1)
  vadHangoverMs: number; // silêncio para encerrar um segmento de fala
  cloneLanguage: string; // idioma da síntese clonada (ex.: "pt")
  cloneRefPath: string | null; // WAV de referência atual (amostra gravada)
  clonePoolSize: number; // 1..3 workers de clonagem em paralelo (~2-3GB RAM cada)
}

export interface EngineStatus {
  whisper: {
    binaryPath: string | null;
    available: boolean;
    installing: boolean;
    canAutoInstall: boolean; // Windows/Linux baixam sozinhos; macOS via brew
    platform: string;
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
  whisperWarmup: 'whisper:warmup', // pré-carrega o modelo no worker
  whisperStop: 'whisper:stop',
  whisperSetup: 'whisper:setup', // baixa o binário whisper.cpp (Win/Linux)
  whisperSetupProgress: 'whisper:setup:progress', // evento main -> renderer
  piperEnsure: 'piper:ensure',
  piperSetup: 'piper:setup',
  piperSetupProgress: 'piper:setup:progress', // evento main -> renderer
  ttsVoices: 'tts:voices', // lista de vozes do Edge TTS
  ttsSynth: 'tts:synth', // síntese (motor conforme argumento)
  ttsExport: 'tts:export',
  saveText: 'file:saveText', // salva texto (ex.: transcrição) em .txt
  saveAudio: 'file:saveAudio', // salva bytes de áudio já gerados (WAV/MP3)
  clipboardWrite: 'clipboard:write', // copia texto (módulo nativo do Electron)
  cloneEnsure: 'clone:ensure',
  cloneSetup: 'clone:setup',
  cloneSetupProgress: 'clone:setup:progress', // evento main -> renderer
  cloneSaveReference: 'clone:saveReference',
  cloneSynth: 'clone:synth',
  cloneSynthSegment: 'clone:synthSegment', // sintetiza uma frase (via pool)
  cloneStop: 'clone:stop', // cancela a geração (mata os workers do pool)
  cloneExport: 'clone:export',
  saveWavFromPcm: 'file:saveWavPcm', // salva PCM float32 concatenado como WAV
  enginesStatus: 'engines:status',
} as const;
