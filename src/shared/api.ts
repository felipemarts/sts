import {
  Catalog,
  DownloadProgress,
  EdgeVoice,
  EngineStatus,
  InstallStatus,
  ModelKind,
  Settings,
  SetupProgress,
  TtsEngine,
} from './types';

export interface PiperEnsure {
  pythonRuntimeReady: boolean; // Python 3.11 embutido já baixado
  venvReady: boolean;
  piperInstalled: boolean;
}

export interface ExportResult {
  canceled: boolean;
  path?: string;
}

export interface CloneEnsure {
  pythonRuntimeReady: boolean; // Python 3.11 embutido já baixado
  venvReady: boolean;
  installed: boolean; // chatterbox importável no venv
  hasReference: boolean; // já existe uma amostra de referência salva
}

/** Superfície exposta ao renderer via contextBridge (window.sts). */
export interface StsApi {
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };
  catalog(): Promise<Catalog>;
  models: {
    status(): Promise<InstallStatus>;
    download(kind: ModelKind, id: string): Promise<void>;
    remove(kind: ModelKind, id: string): Promise<void>;
    onProgress(cb: (p: DownloadProgress) => void): () => void;
  };
  whisper: {
    transcribe(pcm: ArrayBuffer, sampleRate: number, language?: string): Promise<string>;
    stop(): Promise<void>;
    setup(): Promise<void>; // baixa o binário whisper.cpp (Win/Linux)
    onSetupProgress(cb: (p: SetupProgress) => void): () => void;
  };
  /** Leitura de texto — motor Edge (online) ou Piper (local). */
  tts: {
    voices(): Promise<EdgeVoice[]>; // vozes do Edge; as do Piper vêm do catálogo
    synth(text: string, engine: TtsEngine, voice: string, rate: number): Promise<Uint8Array>;
    export(text: string, engine: TtsEngine, voice: string, rate: number): Promise<ExportResult>;
  };
  /** Setup do motor local Piper (venv + piper-tts sobre o Python embutido). */
  piper: {
    ensure(): Promise<PiperEnsure>;
    setup(): Promise<void>;
    onSetupProgress(cb: (p: SetupProgress) => void): () => void;
  };
  clone: {
    ensure(): Promise<CloneEnsure>;
    setup(): Promise<void>;
    onSetupProgress(cb: (p: SetupProgress) => void): () => void;
    saveReference(pcm: ArrayBuffer, sampleRate: number): Promise<string>;
    synth(text: string, language: string): Promise<Uint8Array>;
    synthSegment(text: string, language: string): Promise<Uint8Array>;
    stop(): Promise<void>; // cancela a geração (mata os workers)
    export(text: string, language: string): Promise<ExportResult>;
  };
  engines: {
    status(): Promise<EngineStatus>;
  };
  /** Salva um texto (ex.: transcrição) num .txt escolhido pelo usuário. */
  saveText(text: string, suggestedName: string): Promise<ExportResult>;
  /** Copia texto para a área de transferência (módulo nativo do Electron). */
  copyText(text: string): Promise<void>;
  /** Salva bytes de áudio (WAV/MP3) já gerados num arquivo escolhido pelo usuário. */
  saveAudio(bytes: ArrayBuffer, suggestedName: string): Promise<ExportResult>;
  /** Salva PCM float32 (segmentos concatenados) como WAV/MP3. */
  saveWavFromPcm(pcm: ArrayBuffer, sampleRate: number, suggestedName: string): Promise<ExportResult>;
}
