import { Catalog, PiperVoice, WhisperModel } from '../../shared/types';

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

const MB = 1024 * 1024;

const WHISPER: WhisperModel[] = [
  {
    id: 'tiny',
    label: 'Tiny (multilíngue)',
    sizeBytes: 75 * MB,
    url: `${HF_WHISPER}/ggml-tiny.bin`,
    file: 'ggml-tiny.bin',
    multilingual: true,
    note: 'Mais rápido, menor precisão. Bom para testes.',
  },
  {
    id: 'base',
    label: 'Base (multilíngue)',
    sizeBytes: 142 * MB,
    url: `${HF_WHISPER}/ggml-base.bin`,
    file: 'ggml-base.bin',
    multilingual: true,
    note: 'Equilíbrio leve entre velocidade e qualidade.',
  },
  {
    id: 'small',
    label: 'Small (multilíngue)',
    sizeBytes: 466 * MB,
    url: `${HF_WHISPER}/ggml-small.bin`,
    file: 'ggml-small.bin',
    multilingual: true,
    note: 'Boa qualidade para uso geral em tempo real.',
  },
  {
    id: 'medium',
    label: 'Medium (multilíngue)',
    sizeBytes: 1500 * MB,
    url: `${HF_WHISPER}/ggml-medium.bin`,
    file: 'ggml-medium.bin',
    multilingual: true,
    note: 'Alta qualidade; exige mais CPU.',
  },
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo (multilíngue)',
    sizeBytes: 1560 * MB,
    url: `${HF_WHISPER}/ggml-large-v3-turbo.bin`,
    file: 'ggml-large-v3-turbo.bin',
    multilingual: true,
    note: 'Qualidade próxima do large, bem mais rápido. Recomendado.',
  },
  {
    id: 'large-v3',
    label: 'Large v3 (multilíngue)',
    sizeBytes: 3100 * MB,
    url: `${HF_WHISPER}/ggml-large-v3.bin`,
    file: 'ggml-large-v3.bin',
    multilingual: true,
    note: 'Máxima qualidade; mais lento e pesado.',
  },
];

function voice(
  id: string,
  label: string,
  language: string,
  quality: string,
  sizeMB: number,
  hfPath: string,
): PiperVoice {
  return {
    id,
    label,
    language,
    quality,
    sizeBytes: sizeMB * MB,
    onnxUrl: `${HF_PIPER}/${hfPath}.onnx`,
    configUrl: `${HF_PIPER}/${hfPath}.onnx.json`,
    file: id,
  };
}

const PIPER: PiperVoice[] = [
  voice('pt_BR-faber-medium', 'Português BR — Faber', 'pt_BR', 'medium', 63, 'pt/pt_BR/faber/medium/pt_BR-faber-medium'),
  voice('pt_BR-edresson-low', 'Português BR — Edresson', 'pt_BR', 'low', 28, 'pt/pt_BR/edresson/low/pt_BR-edresson-low'),
  voice('en_US-lessac-medium', 'English US — Lessac', 'en_US', 'medium', 63, 'en/en_US/lessac/medium/en_US-lessac-medium'),
  voice('en_US-amy-medium', 'English US — Amy', 'en_US', 'medium', 63, 'en/en_US/amy/medium/en_US-amy-medium'),
  voice('en_GB-alan-medium', 'English GB — Alan', 'en_GB', 'medium', 63, 'en/en_GB/alan/medium/en_GB-alan-medium'),
  voice('es_ES-davefx-medium', 'Español ES — DaveFX', 'es_ES', 'medium', 63, 'es/es_ES/davefx/medium/es_ES-davefx-medium'),
  voice('fr_FR-siwis-medium', 'Français FR — Siwis', 'fr_FR', 'medium', 63, 'fr/fr_FR/siwis/medium/fr_FR-siwis-medium'),
  voice('de_DE-thorsten-medium', 'Deutsch DE — Thorsten', 'de_DE', 'medium', 63, 'de/de_DE/thorsten/medium/de_DE-thorsten-medium'),
  voice('it_IT-riccardo-x_low', 'Italiano IT — Riccardo', 'it_IT', 'x_low', 20, 'it/it_IT/riccardo/x_low/it_IT-riccardo-x_low'),
];

export function getCatalog(): Catalog {
  return { whisper: WHISPER, piper: PIPER };
}

export function findWhisper(id: string): WhisperModel | undefined {
  return WHISPER.find((m) => m.id === id);
}

export function findVoice(id: string): PiperVoice | undefined {
  return PIPER.find((v) => v.id === id);
}
