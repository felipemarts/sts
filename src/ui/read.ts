import { el } from './dom';
import { Tab } from './listen';

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

  const updateButtons = () => {
    playBtn.disabled = playing;
    playBtn.textContent = playing ? '🔊  Lendo…' : '▶  Ler';
    stopBtn.disabled = !playing;
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
    errorBox.textContent = '';
    updateButtons();

    if (!ctx) ctx = new AudioContext();
    await ctx.resume();

    const voice = voiceSelect.value;
    const r = parseFloat(rate.value);
    const synth = (i: number) => window.sts.piper.synth(chunks[i], voice, r);
    let nextP: Promise<Uint8Array> | null = null;

    for (let i = startIndex; i < chunks.length; i++) {
      if (myRun !== runId) return;
      let wav: Uint8Array;
      try {
        wav = await (nextP ?? synth(i));
      } catch (err) {
        if (myRun === runId) errorBox.textContent = err instanceof Error ? err.message : String(err);
        break;
      }
      if (myRun !== runId) return;
      nextP = i + 1 < chunks.length ? synth(i + 1) : null; // prefetch do próximo

      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(wav.slice().buffer);
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
    stopCurrentSource();
    playing = false;
    clearActive();
    updateButtons();
  };

  // Valida texto/voz/engine. Retorna o texto ou null.
  const ensureReady = async (): Promise<string | null> => {
    errorBox.textContent = '';
    saveStatus.textContent = '';
    const text = textarea.value.trim();
    if (!text) return null;
    if (!voiceSelect.value) {
      errorBox.textContent = 'Baixe uma voz em Configurações antes.';
      goToSettings();
      return null;
    }
    const ensured = await window.sts.piper.ensure();
    if (!ensured.piperInstalled) {
      errorBox.textContent =
        'O motor Piper ainda não foi instalado. Vá em Configurações e clique em "Instalar Piper".';
      goToSettings();
      return null;
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
      const res = await window.sts.piper.export(text, voiceSelect.value, parseFloat(rate.value));
      if (!res.canceled && res.path) saveStatus.textContent = `✓ Salvo em: ${res.path}`;
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾  Salvar…';
    }
  };

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
  voiceSelect.addEventListener('change', () =>
    window.sts.settings.set({ piperVoice: voiceSelect.value }),
  );
  playBtn.addEventListener('click', play);
  stopBtn.addEventListener('click', stopAll);
  saveBtn.addEventListener('click', save);

  const element = el('div', { class: 'panel', id: 'panel-read' }, [
    el('h2', {}, ['Ler']),
    el('p', { class: 'sub' }, [
      'Digite um texto e ouça a leitura com voz neural local (Piper). Textos longos começam a tocar já no 1º parágrafo.',
    ]),
    el('div', { class: 'card' }, [textarea]),
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('label', { class: 'field', style: 'flex:2' }, ['Voz', voiceSelect]),
        el('label', { class: 'field' }, [el('span', {}, ['Velocidade ', rateVal]), rate]),
        el('label', { class: 'field' }, [el('span', {}, ['Volume ', volVal]), volume]),
      ]),
      el('div', { class: 'row' }, [
        playBtn, stopBtn, saveBtn, el('span', { style: 'flex:1' }), statusPill,
      ]),
      saveStatus,
    ]),
    el('div', { class: 'card' }, [readingHint, reading]),
    errorBox,
  ]);

  const refresh = async () => {
    const s = await window.sts.settings.get();
    const cat = await window.sts.catalog();
    const status = await window.sts.models.status();

    voiceSelect.innerHTML = '';
    const installed = cat.piper.filter((v) => status[v.id]);
    if (installed.length === 0) {
      voiceSelect.append(el('option', { value: '' }, ['(nenhuma voz baixada)']));
      statusPill.textContent = 'Sem vozes';
      statusPill.className = 'pill bad';
    } else {
      for (const v of installed) voiceSelect.append(el('option', { value: v.id }, [v.label]));
      if (s.piperVoice && installed.some((v) => v.id === s.piperVoice)) {
        voiceSelect.value = s.piperVoice;
      }
      statusPill.textContent = `${installed.length} voz(es) disponível(is)`;
      statusPill.className = 'pill ok';
    }

    rate.value = String(s.ttsRate);
    rateVal.textContent = `${s.ttsRate.toFixed(2)}×`;
    volume.value = String(s.ttsVolume);
    volVal.textContent = `${Math.round(s.ttsVolume * 100)}%`;
    updateButtons();
  };

  return { element, refresh };
}
