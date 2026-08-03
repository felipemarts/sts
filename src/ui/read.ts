import { el } from './dom';
import { Tab } from './listen';
import { EdgeVoice, TtsEngine } from '../shared/types';

/** Quebra em frases agrupando até ~300 caracteres (para blocos longos). */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…\n]+[.!?…]*(\s+|$)/g) || [text];
  const chunks: string[] = [];
  let cur = '';
  for (const s of parts) {
    if (cur && (cur + s).length > 300) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/** Quebra o texto em parágrafos; parágrafos muito longos viram frases. */
function splitIntoChunks(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const source = paras.length > 1 ? paras : splitSentences(text);
  return source.flatMap((p) => (p.length > 400 ? splitSentences(p) : [p]));
}

export function createReadTab(goToSettings: () => void): Tab {
  const textarea = el('textarea', {
    placeholder: 'Digite ou cole o texto que você quer ouvir…',
  }) as HTMLTextAreaElement;
  const engineSelect = el('select', {}, []) as HTMLSelectElement;
  for (const [v, l] of [
    ['edge', 'Neural (Edge · online)'],
    ['piper', 'Local (Piper)'],
  ]) {
    engineSelect.append(el('option', { value: v }, [l]));
  }
  const voiceSelect = el('select', {}, []) as HTMLSelectElement;
  const rate = el('input', {
    type: 'range', min: '0.5', max: '2', step: '0.05', value: '1',
  }) as HTMLInputElement;
  const volume = el('input', {
    type: 'range', min: '0', max: '1', step: '0.05', value: '1',
  }) as HTMLInputElement;
  const rateVal = el('span', { class: 'value' }, ['1.00×']);
  const volVal = el('span', { class: 'value' }, ['100%']);
  const playBtn = el('button', { class: 'primary' }, ['▶  Ler']) as HTMLButtonElement;
  const pauseBtn = el('button', { class: 'ghost' }, ['⏸  Pausar']) as HTMLButtonElement;
  const stopBtn = el('button', { class: 'ghost' }, ['⏹  Parar']) as HTMLButtonElement;
  const saveBtn = el('button', {}, ['💾  Salvar…']) as HTMLButtonElement;
  const statusPill = el('span', { class: 'pill' }, ['—']);
  const errorBox = el('div', { class: 'error' });
  const saveStatus = el('div', { class: 'hint' });
  const reading = el('div', { class: 'reading' });
  const readingHint = el('p', { class: 'hint' }, [
    'Ao ler, o texto aparece aqui em parágrafos e o trecho atual fica destacado. Clique num parágrafo para começar por ele.',
  ]);

  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let currentSource: AudioBufferSourceNode | null = null;

  let chunks: string[] = [];
  let paraEls: HTMLElement[] = [];
  let runId = 0;
  let playing = false;
  let paused = false;
  let edgeVoices: EdgeVoice[] = [];

  const engine = (): TtsEngine => (engineSelect.value as TtsEngine) || 'edge';

  const updateButtons = () => {
    playBtn.disabled = playing;
    playBtn.textContent = playing ? (paused ? '⏸  Pausado' : '🔊  Lendo…') : '▶  Ler';
    stopBtn.disabled = !playing;
    pauseBtn.disabled = !playing;
    pauseBtn.textContent = paused ? '▶  Retomar' : '⏸  Pausar';
  };

  // Pausa/retoma no ponto exato: suspender o AudioContext congela o relógio de
  // áudio (o buffer em reprodução para) e resume() continua de onde parou.
  const togglePause = async () => {
    if (!playing || !ctx) return;
    if (paused) {
      await ctx.resume();
      paused = false;
    } else {
      await ctx.suspend();
      paused = true;
    }
    updateButtons();
  };

  const stopCurrentSource = () => {
    if (currentSource) {
      try {
        currentSource.stop();
      } catch {
        /* ignore */
      }
      currentSource = null;
    }
  };

  const clearActive = () => paraEls.forEach((e) => e.classList.remove('active'));

  const highlight = (i: number) => {
    paraEls.forEach((e, j) => {
      e.classList.toggle('active', j === i);
      if (j < i) e.classList.add('done');
    });
    paraEls[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const buildReadingPane = () => {
    reading.innerHTML = '';
    paraEls = chunks.map((text, i) => {
      const p = el('div', { class: 'para', onClick: () => runFrom(i) }, [text]);
      reading.append(p);
      return p;
    });
  };

  const playBuffer = (buf: AudioBuffer): Promise<void> =>
    new Promise((resolve) => {
      gain = ctx!.createGain();
      gain.gain.value = parseFloat(volume.value);
      const src = ctx!.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      gain.connect(ctx!.destination);
      currentSource = src;
      src.onended = () => {
        if (currentSource === src) currentSource = null;
        resolve();
      };
      src.start();
    });

  // Toca a partir do índice, sintetizando o próximo enquanto o atual toca.
  async function runFrom(startIndex: number) {
    const myRun = ++runId; // invalida qualquer leitura anterior
    stopCurrentSource();
    playing = true;
    paused = false;
    errorBox.textContent = '';
    updateButtons();

    if (!ctx) ctx = new AudioContext();
    await ctx.resume();

    const eng = engine();
    const voice = voiceSelect.value;
    const r = parseFloat(rate.value);
    const synth = (i: number) => window.sts.tts.synth(chunks[i], eng, voice, r);
    let nextP: Promise<Uint8Array> | null = null;

    for (let i = startIndex; i < chunks.length; i++) {
      if (myRun !== runId) return;
      let audio: Uint8Array;
      try {
        audio = await (nextP ?? synth(i));
      } catch (err) {
        if (myRun === runId) errorBox.textContent = err instanceof Error ? err.message : String(err);
        break;
      }
      if (myRun !== runId) return;
      nextP = i + 1 < chunks.length ? synth(i + 1) : null; // prefetch do próximo

      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(audio.slice().buffer);
      } catch (err) {
        if (myRun === runId) errorBox.textContent = err instanceof Error ? err.message : String(err);
        break;
      }
      if (myRun !== runId) return;

      highlight(i);
      await playBuffer(audioBuffer);
      if (myRun !== runId) return;
    }

    if (myRun === runId) {
      playing = false;
      clearActive();
      updateButtons();
    }
  }

  const stopAll = () => {
    runId++; // encerra o loop em andamento
    // Se estava pausado, retoma o contexto para o stop() da fonte fazer efeito.
    if (ctx && ctx.state === 'suspended') ctx.resume();
    paused = false;
    stopCurrentSource();
    playing = false;
    clearActive();
    updateButtons();
  };

  // Valida texto/voz/motor. Retorna o texto ou null.
  const ensureReady = async (): Promise<string | null> => {
    errorBox.textContent = '';
    saveStatus.textContent = '';
    const text = textarea.value.trim();
    if (!text) return null;
    if (!voiceSelect.value) {
      errorBox.textContent =
        engine() === 'piper'
          ? 'Baixe uma voz Piper em Configurações antes.'
          : 'Nenhuma voz disponível.';
      if (engine() === 'piper') goToSettings();
      return null;
    }
    if (engine() === 'piper') {
      const ensured = await window.sts.piper.ensure();
      if (!ensured.piperInstalled) {
        errorBox.textContent =
          'O motor Piper ainda não foi instalado. Vá em Configurações e clique em "Instalar Piper".';
        goToSettings();
        return null;
      }
    }
    return text;
  };

  const play = async () => {
    const text = await ensureReady();
    if (!text) return;
    chunks = splitIntoChunks(text);
    if (!chunks.length) return;
    buildReadingPane();
    runFrom(0);
  };

  const save = async () => {
    const text = await ensureReady();
    if (!text) return;
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳  Salvando…';
    try {
      const res = await window.sts.tts.export(text, engine(), voiceSelect.value, parseFloat(rate.value));
      if (!res.canceled && res.path) saveStatus.textContent = `✓ Salvo em: ${res.path}`;
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾  Salvar…';
    }
  };

  // ------- Popular vozes conforme o motor -------
  async function fillVoices() {
    const s = await window.sts.settings.get();
    voiceSelect.innerHTML = '';
    if (engine() === 'edge') {
      if (!edgeVoices.length) {
        try {
          edgeVoices = await window.sts.tts.voices();
        } catch {
          edgeVoices = [];
        }
      }
      if (!edgeVoices.length) {
        voiceSelect.append(el('option', { value: '' }, ['(sem conexão para listar vozes)']));
        statusPill.textContent = 'Edge · offline?';
        statusPill.className = 'pill bad';
      } else {
        for (const v of edgeVoices) {
          voiceSelect.append(el('option', { value: v.shortName }, [v.friendlyName]));
        }
        const want = s.edgeVoice && edgeVoices.some((v) => v.shortName === s.edgeVoice)
          ? s.edgeVoice
          : edgeVoices.find((v) => v.locale === 'pt-BR')?.shortName ?? edgeVoices[0].shortName;
        voiceSelect.value = want;
        if (!s.edgeVoice) window.sts.settings.set({ edgeVoice: want });
        statusPill.textContent = `${edgeVoices.length} vozes neurais`;
        statusPill.className = 'pill ok';
      }
    } else {
      const cat = await window.sts.catalog();
      const status = await window.sts.models.status();
      const installed = cat.piper.filter((v) => status[v.id]);
      if (!installed.length) {
        voiceSelect.append(el('option', { value: '' }, ['(baixe uma voz Piper em Configurações)']));
        statusPill.textContent = 'Sem vozes Piper';
        statusPill.className = 'pill bad';
      } else {
        for (const v of installed) voiceSelect.append(el('option', { value: v.id }, [v.label]));
        if (s.piperVoice && installed.some((v) => v.id === s.piperVoice)) {
          voiceSelect.value = s.piperVoice;
        }
        statusPill.textContent = `${installed.length} voz(es) Piper`;
        statusPill.className = 'pill ok';
      }
    }
  }

  rate.addEventListener('input', () => {
    rateVal.textContent = `${parseFloat(rate.value).toFixed(2)}×`;
  });
  rate.addEventListener('change', () =>
    window.sts.settings.set({ ttsRate: parseFloat(rate.value) }),
  );
  volume.addEventListener('input', () => {
    const v = parseFloat(volume.value);
    volVal.textContent = `${Math.round(v * 100)}%`;
    if (gain) gain.gain.value = v;
  });
  volume.addEventListener('change', () =>
    window.sts.settings.set({ ttsVolume: parseFloat(volume.value) }),
  );
  engineSelect.addEventListener('change', async () => {
    await window.sts.settings.set({ ttsEngine: engine() });
    await fillVoices();
  });
  voiceSelect.addEventListener('change', () => {
    if (engine() === 'edge') window.sts.settings.set({ edgeVoice: voiceSelect.value });
    else window.sts.settings.set({ piperVoice: voiceSelect.value });
  });
  playBtn.addEventListener('click', play);
  pauseBtn.addEventListener('click', togglePause);
  stopBtn.addEventListener('click', stopAll);
  saveBtn.addEventListener('click', save);

  const element = el('div', { class: 'panel', id: 'panel-read' }, [
    el('h2', {}, ['Ler']),
    el('p', { class: 'sub' }, [
      'Digite um texto e ouça a leitura com voz neural. O motor "Neural (Edge)" funciona na hora (online, sem instalação); o "Local (Piper)" roda 100% offline após instalar em Configurações.',
    ]),
    el('div', { class: 'card' }, [textarea]),
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('label', { class: 'field' }, ['Motor', engineSelect]),
        el('label', { class: 'field', style: 'flex:2' }, ['Voz', voiceSelect]),
        el('label', { class: 'field' }, [el('span', {}, ['Velocidade ', rateVal]), rate]),
        el('label', { class: 'field' }, [el('span', {}, ['Volume ', volVal]), volume]),
      ]),
      el('div', { class: 'row' }, [
        playBtn, pauseBtn, stopBtn, saveBtn, el('span', { style: 'flex:1' }), statusPill,
      ]),
      saveStatus,
    ]),
    el('div', { class: 'card' }, [readingHint, reading]),
    errorBox,
  ]);

  const refresh = async () => {
    const s = await window.sts.settings.get();
    engineSelect.value = s.ttsEngine;
    await fillVoices();
    rate.value = String(s.ttsRate);
    rateVal.textContent = `${s.ttsRate.toFixed(2)}×`;
    volume.value = String(s.ttsVolume);
    volVal.textContent = `${Math.round(s.ttsVolume * 100)}%`;
    updateButtons();
  };

  return { element, refresh };
}
