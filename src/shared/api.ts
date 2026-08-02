import {
  Catalog,
  DownloadProgress,
  EngineStatus,
  InstallStatus,
  ModelKind,
  Settings,
  SetupProgress,
} from './types';

export interface PiperEnsure {
  systemPython: string | null;
  venvReady: boolean;
  piperInstalled: boolean;
}

export interface ExportResult {
  canceled: boolean;
  path?: string;
}

export interface CloneEnsure {
  python311: string | null; // caminho do Python 3.11 encontrado (ou null)
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
  };
  piper: {
    ensure(): Promise<PiperEnsure>;
    setup(): Promise<void>;
    onSetupProgress(cb: (p: SetupProgress) => void): () => void;
    synth(text: string, voiceId: string, rate: number): Promise<Uint8Array>;
    export(text: string, voiceId: string, rate: number): Promise<ExportResult>;
  };
  clone: {
    ensure(): Promise<CloneEnsure>;
    setup(): Promise<void>;
    onSetupProgress(cb: (p: SetupProgress) => void): () => void;
    saveReference(pcm: ArrayBuffer, sampleRate: number): Promise<string>;
    synth(text: string, language: string): Promise<Uint8Array>;
    export(text: string, language: string): Promise<ExportResult>;
  };
  engines: {
    status(): Promise<EngineStatus>;
  };
}
