/**
 * TTS neural via serviço "Read Aloud" do Microsoft Edge (mesmas vozes do Azure).
 * Gratuito, sem chave e sem Python — protocolo WebSocket usado pelo próprio Edge.
 *
 * Portado do projeto `agent` (que usa isso em produção). Diferente do Piper,
 * não exige nenhuma instalação: funciona assim que o app abre (precisa de
 * internet). O áudio do microfone nunca é enviado — só o TEXTO a ser lido.
 */
import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { EdgeVoice } from '../../shared/types';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICES_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list';
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';
// O serviço rejeita versões antigas (403) — manter razoavelmente atual.
const SEC_MS_GEC_VERSION = '1-138.0.3351.65';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0';

/** Idiomas expostos na UI (mesmos da aba Escutar). */
const SUPPORTED_LOCALES = ['pt-BR', 'pt-PT', 'en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT'];

/** Vozes conhecidas, usadas como fallback se a listagem online falhar. */
const FALLBACK_VOICES: EdgeVoice[] = [
  { shortName: 'pt-BR-FranciscaNeural', locale: 'pt-BR', gender: 'Female', friendlyName: 'Francisca — Português (BR, feminina)' },
  { shortName: 'pt-BR-AntonioNeural', locale: 'pt-BR', gender: 'Male', friendlyName: 'Antônio — Português (BR, masculina)' },
  { shortName: 'pt-PT-RaquelNeural', locale: 'pt-PT', gender: 'Female', friendlyName: 'Raquel — Português (PT, feminina)' },
  { shortName: 'en-US-AriaNeural', locale: 'en-US', gender: 'Female', friendlyName: 'Aria — English (US, feminina)' },
  { shortName: 'en-US-GuyNeural', locale: 'en-US', gender: 'Male', friendlyName: 'Guy — English (US, masculina)' },
  { shortName: 'en-GB-SoniaNeural', locale: 'en-GB', gender: 'Female', friendlyName: 'Sonia — English (GB, feminina)' },
  { shortName: 'es-ES-ElviraNeural', locale: 'es-ES', gender: 'Female', friendlyName: 'Elvira — Español (ES, feminina)' },
  { shortName: 'fr-FR-DeniseNeural', locale: 'fr-FR', gender: 'Female', friendlyName: 'Denise — Français (FR, feminina)' },
  { shortName: 'de-DE-KatjaNeural', locale: 'de-DE', gender: 'Female', friendlyName: 'Katja — Deutsch (DE, feminina)' },
  { shortName: 'it-IT-ElsaNeural', locale: 'it-IT', gender: 'Female', friendlyName: 'Elsa — Italiano (IT, feminina)' },
];

/**
 * Token anti-abuso exigido pelo endpoint: SHA-256 de (ticks Windows arredondados
 * a 5 min + trusted token), em hex maiúsculo.
 */
function secMsGec(): string {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + 11644473600n;
  ticks -= ticks % 300n;
  ticks *= 10_000_000n;
  return createHash('sha256')
    .update(`${ticks}${TRUSTED_CLIENT_TOKEN}`)
    .digest('hex')
    .toUpperCase();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** rate 1.0 = normal → formato do SSML ("+15%" / "-10%"). */
function rateToSsml(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** Deriva o locale (ex.: "pt-BR") do shortName da voz. */
function localeOf(voice: string): string {
  const m = voice.match(/^([a-z]{2}-[A-Z]{2})/);
  return m ? m[1] : 'pt-BR';
}

export interface EdgeSynthOptions {
  voice: string;
  rate: number; // 1.0 = normal
}

/** Sintetiza `text` e devolve o MP3 completo. Rejeita em erro/timeout. */
export function synthEdge(text: string, opts: EdgeSynthOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const connectionId = randomUUID().replace(/-/g, '');
    const url =
      `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${connectionId}`;

    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': UA,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      },
    });

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };

    const timer = setTimeout(() => finish(new Error('Edge TTS: timeout (20s)')), 20_000);

    ws.on('open', () => {
      const ts = new Date().toISOString();
      ws.send(
        `X-Timestamp:${ts}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: {
                    sentenceBoundaryEnabled: 'false',
                    wordBoundaryEnabled: 'false',
                  },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          }),
      );

      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${localeOf(opts.voice)}'>` +
        `<voice name='${opts.voice}'><prosody rate='${rateToSsml(opts.rate)}'>` +
        escapeXml(text) +
        `</prosody></voice></speak>`;

      ws.send(
        `X-RequestId:${connectionId}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${ts}\r\n` +
          'Path:ssml\r\n\r\n' +
          ssml,
      );
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Frame binário: 2 bytes (tamanho do header) + header + áudio.
        const headerLen = data.readUInt16BE(0);
        const header = data.subarray(2, 2 + headerLen).toString('utf-8');
        if (header.includes('Path:audio')) chunks.push(data.subarray(2 + headerLen));
      } else {
        const msg = data.toString();
        if (msg.includes('Path:turn.end')) finish();
      }
    });

    ws.on('error', (err: Error) => finish(new Error(`Edge TTS: ${err.message}`)));
    ws.on('close', () => {
      if (!settled) {
        finish(chunks.length ? undefined : new Error('Edge TTS: conexão fechada sem áudio.'));
      }
    });
  });
}

let voicesCache: EdgeVoice[] | null = null;

function friendly(shortName: string, locale: string, gender: string): string {
  const name = shortName.replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/(Multilingual)?Neural$/, '');
  const g = gender === 'Female' ? 'feminina' : 'masculina';
  return `${name} — ${locale} (${g})`;
}

/** Lista as vozes dos idiomas suportados (com cache; fallback offline). */
export async function listEdgeVoices(): Promise<EdgeVoice[]> {
  if (voicesCache) return voicesCache;
  try {
    const res = await fetch(
      `${VOICES_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}` +
        `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = (await res.json()) as Array<{
      ShortName: string;
      Locale: string;
      Gender: string;
    }>;
    const voices = all
      .filter((v) => SUPPORTED_LOCALES.includes(v.Locale))
      .map((v) => ({
        shortName: v.ShortName,
        locale: v.Locale,
        gender: v.Gender,
        friendlyName: friendly(v.ShortName, v.Locale, v.Gender),
      }));
    voicesCache = voices.length ? voices : FALLBACK_VOICES;
  } catch (err) {
    console.error('[edge-tts] falha ao listar vozes, usando fallback:', err);
    voicesCache = FALLBACK_VOICES;
  }
  return voicesCache;
}
