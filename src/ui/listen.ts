import { el } from './dom';
import { startCapture, CaptureHandle } from './audioCapture';
import { findWhisper } from '../backend/models/catalog';

export interface Tab {
  element: HTMLElement;
  refresh: () => void | Promise<void>;
}

/** Mistura os canais de um AudioBuffer em um float32 mono. */
function toMono(audio: AudioBuffer): Float32Array {
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const n = audio.length;
  const out = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / audio.numberOfChannels;
  }
  return out;
}

/** Reamostra float32 para 16 kHz (o que o whisper.cpp espera). */
function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  const toRate = 16000;
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (idx - i0);
  }
  return out;
}

export function createListenTab(goToSettings: () => void): Tab {
  const statusPill = el('span', { class: 'pill' }, ['—']);
  const startBtn = el('button', { class: 'primary' }, ['▶  Iniciar captura']);
  const clearBtn = el('button', { class: 'ghost' }, ['Limpar']);
  const copyBtn = el('button', { class: 'ghost' }, ['Copiar']);
  const uploadBtn = el('button', { class: 'ghost' }, ['📁  Transcrever áudio']) as HTMLButtonElement;
  const fileInput = el('input', {
    type: 'file',
    accept: 'audio/*,.mp3,.wav,.m4a,.ogg,.flac,.webm',
    style: 'display:none',
  }) as HTMLInputElement;
  const saveTxtBtn = el('button', { class: 'ghost' }, ['💾  Salvar .txt']);
  const savedHint = el('div', { class: 'hint' });
  const meterFill = el('div');
  const meter = el('div', { class: 'meter' }, [meterFill]);
  const transcript = el('textarea', {
    class: 'transcript',
    placeholder: 'A transcrição aparece aqui — você pode editar o texto livremente.',
  }) as HTMLTextAreaElement;
  const working = el('span', { class: 'interim' });
  const errorBox = el('div', { class: 'error' });
  const langSelect = el('select', {}, []) as HTMLSelectElement;

  for (const [val, label] of [
    ['auto', 'Detectar idioma'],
    ['pt', 'Português'],
    ['en', 'Inglês'],
    ['es', 'Espanhol'],
    ['fr', 'Francês'],
    ['de', 'Alemão'],
    ['it', 'Italiano'],
  ]) {
    langSelect.append(el('option', { value: val }, [label]));
  }

  let capturing = false;
  let handle: CaptureHandle | null = null;
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let gotChunk = false;
  let maxLevel = 0;
  let signalTimer: ReturnType<typeof setTimeout> | null = null;

  langSelect.addEventListener('change', () => {
    window.sts.settings.set({ whisperLanguage: langSelect.value });
  });

  // Só o indicador de progresso; o textarea é editável e NÃO é reescrito a cada
  // render (senão perderia as edições do usuário). Cada trecho é anexado.
  const render = () => {
    working.textContent = pending > 0
      ? `● transcrevendo ${pending} trecho${pending > 1 ? 's' : ''}…`
      : '';
  };

  const appendText = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const cur = transcript.value;
    const sep = cur && !/\s$/.test(cur) ? ' ' : '';
    transcript.value = cur + sep + clean;
    transcript.scrollTop = transcript.scrollHeight;
  };

  // Transcreve um arquivo de áudio enviado (MP3/WAV/M4A/OGG/FLAC…). Decodifica
  // no renderer (Web Audio), reamostra p/ 16 kHz mono e manda ao Whisper em
  // blocos de 30s (evita o timeout e mostra progresso).
  let fileBusy = false;
  async function transcribeFile(file: File) {
    if (fileBusy || capturing) return;
    errorBox.textContent = '';
    const s = await window.sts.settings.get();
    const status = await window.sts.models.status();
    if (!s.whisperModel || !status[s.whisperModel]) {
      errorBox.textContent = 'Selecione e baixe um modelo Whisper em Configurações antes.';
      goToSettings();
      return;
    }
    const eng = await window.sts.engines.status();
    if (!eng.whisper.available) {
      errorBox.textContent = eng.whisper.canAutoInstall
        ? 'O whisper.cpp ainda não foi instalado. Vá em Configurações e clique em "Instalar Whisper".'
        : 'whisper.cpp não encontrado. Instale com: brew install whisper-cpp.';
      goToSettings();
      return;
    }
    fileBusy = true;
    uploadBtn.disabled = true;
    uploadBtn.textContent = '⏳  Lendo áudio…';
    const actx = new AudioContext();
    try {
      const arr = await file.arrayBuffer();
      const audio = await actx.decodeAudioData(arr);
      const pcm16 = resampleTo16k(toMono(audio), audio.sampleRate);
      const CH = 16000 * 30; // blocos de 30s (janela nativa do Whisper)
      const total = Math.max(1, Math.ceil(pcm16.length / CH));
      for (let i = 0; i < total; i++) {
        working.textContent = `● transcrevendo arquivo — bloco ${i + 1}/${total}…`;
        const copy = pcm16.slice(i * CH, Math.min((i + 1) * CH, pcm16.length));
        const text = await window.sts.whisper.transcribe(copy.buffer as ArrayBuffer, 16000, langSelect.value);
        if (text) appendText(text);
      }
      working.textContent = '';
    } catch (err) {
      errorBox.textContent = 'Falha ao transcrever o arquivo: ' + (err instanceof Error ? err.message : String(err));
      working.textContent = '';
    } finally {
      try { await actx.close(); } catch { /* ignore */ }
      fileBusy = false;
      uploadBtn.disabled = false;
      uploadBtn.textContent = '📁  Transcrever áudio';
    }
  }

  const enqueue = (pcm: Float32Array, sampleRate: number) => {
    pending++;
    render();
    queue = queue.then(async () => {
      try {
        const text = await window.sts.whisper.transcribe(
          pcm.buffer as ArrayBuffer,
          sampleRate,
          langSelect.value,
        );
        if (text) appendText(text);
      } catch (err) {
        errorBox.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        pending--;
        render();
      }
    });
  };

  const stop = async () => {
    capturing = false;
    if (signalTimer) {
      clearTimeout(signalTimer);
      signalTimer = null;
    }
    startBtn.textContent = '▶  Iniciar captura';
    startBtn.classList.remove('rec');
    startBtn.classList.add('primary');
    meterFill.style.width = '0%';
    if (handle) {
      // handle.stop() finaliza o trecho de fala em andamento (últimas palavras)
      // e o enfileira. NÃO cancelamos a transcrição: a fila termina de processar
      // o que já foi capturado — a UI mostra "transcrevendo…" até concluir.
      await handle.stop();
      handle = null;
    }
    render();
  };

  const start = async () => {
    errorBox.textContent = '';
    const s = await window.sts.settings.get();
    const status = await window.sts.models.status();
    if (!s.whisperModel || !status[s.whisperModel]) {
      errorBox.textContent =
        'Selecione e baixe um modelo Whisper em Configurações antes de iniciar.';
      goToSettings();
      return;
    }
    const eng = await window.sts.engines.status();
    if (!eng.whisper.available) {
      errorBox.textContent = eng.whisper.canAutoInstall
        ? 'O whisper.cpp ainda não foi instalado. Vá em Configurações e clique em "Instalar Whisper" (baixa ~30 MB, uma vez só).'
        : 'whisper.cpp não encontrado. Instale com: brew install whisper-cpp.';
      goToSettings();
      return;
    }
    gotChunk = false;
    maxLevel = 0;
    try {
      handle = await startCapture({
        deviceId: s.micDeviceId,
        threshold: s.vadThreshold,
        hangoverMs: s.vadHangoverMs,
        onLevel: (rms) => {
          gotChunk = true;
          if (rms > maxLevel) maxLevel = rms;
          // Escala sensível: fala normal (rms ~0,03–0,12) já enche boa parte da barra.
          const pct = Math.min(100, Math.round(rms * 600));
          meterFill.style.width = `${pct}%`;
        },
        onSegment: (pcm, sr) => enqueue(pcm, sr),
        onError: (e) => (errorBox.textContent = e.message),
      });
      capturing = true;
      startBtn.textContent = '⏹  Parar captura';
      startBtn.classList.remove('primary');
      startBtn.classList.add('rec');

      // Watchdog: avisa se nenhum áudio (ou só silêncio) chegar do microfone.
      signalTimer = setTimeout(() => {
        if (!capturing) return;
        if (!gotChunk) {
          errorBox.textContent =
            'Nenhum áudio chegou do microfone. Verifique a permissão do sistema ' +
            '(Ajustes › Privacidade e Segurança › Microfone) e o dispositivo em Configurações.';
        } else if (maxLevel < 0.003) {
          errorBox.textContent =
            'Microfone praticamente em silêncio. Confira o dispositivo de entrada e o volume, ' +
            'ou selecione outro microfone em Configurações.';
        }
      }, 4000);
    } catch (err) {
      errorBox.textContent =
        'Falha ao acessar o microfone: ' +
        (err instanceof Error ? err.message : String(err));
    }
  };

  startBtn.addEventListener('click', () => (capturing ? stop() : start()));
  clearBtn.addEventListener('click', () => {
    transcript.value = '';
    errorBox.textContent = '';
    savedHint.textContent = '';
    render();
  });
  copyBtn.addEventListener('click', async () => {
    await window.sts.copyText(transcript.value);
    const prev = copyBtn.textContent;
    copyBtn.textContent = '✓ Copiado';
    setTimeout(() => { copyBtn.textContent = prev; }, 1200);
  });
  uploadBtn.addEventListener('click', () => {
    if (!uploadBtn.disabled) fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) await transcribeFile(f);
  });

  const stamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  saveTxtBtn.addEventListener('click', async () => {
    const text = transcript.value.trim();
    errorBox.textContent = '';
    if (!text) {
      errorBox.textContent = 'Nada para salvar ainda — fale algo primeiro.';
      return;
    }
    try {
      const res = await window.sts.saveText(text, `transcricao-${stamp()}.txt`);
      if (!res.canceled && res.path) savedHint.textContent = `✓ Salvo em: ${res.path}`;
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  const element = el('div', { class: 'panel', id: 'panel-listen' }, [
    el('h2', {}, ['Escutar']),
    el('p', { class: 'sub' }, [
      'Fale ao microfone (transcrição em tempo real) ou envie um arquivo de áudio (MP3/WAV/M4A…) para extrair o texto. Whisper local.',
    ]),
    fileInput,
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        startBtn,
        clearBtn,
        copyBtn,
        uploadBtn,
        saveTxtBtn,
        el('span', { class: 'spacer', style: 'flex:1' }),
        statusPill,
      ]),
      el('div', { class: 'row' }, [
        el('label', { class: 'field' }, ['Idioma', langSelect]),
        el('label', { class: 'field', style: 'flex:2' }, [
          'Nível do microfone',
          meter,
        ]),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'row', style: 'margin-bottom:8px' }, [
        el('span', { class: 'hint' }, ['Transcrição (editável)']),
        el('span', { style: 'flex:1' }),
        working,
      ]),
      transcript,
    ]),
    savedHint,
    errorBox,
  ]);

  const refresh = async () => {
    const s = await window.sts.settings.get();
    langSelect.value = s.whisperLanguage;
    const status = await window.sts.models.status();
    if (s.whisperModel && status[s.whisperModel]) {
      const m = findWhisper(s.whisperModel);
      statusPill.textContent = `Modelo: ${m?.label ?? s.whisperModel}`;
      statusPill.className = 'pill ok';
      startBtn.disabled = false;
    } else {
      statusPill.textContent = 'Nenhum modelo baixado';
      statusPill.className = 'pill bad';
    }
    render();
  };

  return { element, refresh };
}
