import fs from 'node:fs';
import { Settings } from '../shared/types';
import { settingsFile } from './paths';

const DEFAULTS: Settings = {
  micDeviceId: null,
  whisperModel: null,
  whisperLanguage: 'auto',
  whisperServerPath: null,
  ttsEngine: 'edge',
  edgeVoice: null,
  piperVoice: null,
  ttsRate: 1.0,
  ttsVolume: 1.0,
  vadThreshold: 0.015,
  vadHangoverMs: 700,
};

let cache: Settings | null = null;

/** Mantém só as chaves conhecidas (descarta settings de features removidas). */
function prune(raw: Record<string, unknown>): Settings {
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  return out as unknown as Settings;
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    cache = prune(JSON.parse(raw));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  cache = next;
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('Falha ao salvar settings:', err);
  }
  return next;
}
