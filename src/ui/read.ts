import { el } from './dom';
import { Tab } from './listen';

export function createReadTab(goToSettings: () => void): Tab {
  const textarea = el('textarea', {
    placeholder: 'Digite ou cole o texto que você quer ouvir…',
  }) as HTMLTextAreaElement;
  const voiceSelect = el('select', {}, []) as HTMLSelectElement;
  const rate = el('input', {
    type: 'range',
    min: '0.5',
    max: '2',
    step: '0.05',
    value: '1',
  }) as HTMLInputElement;
  const volume = el('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    value: '1',
  }) as HTMLInputElement;
  const rateVal = el('span', { class: 'value' }, ['1.00×']);
  const volVal = el('span', { class: 'value' }, ['100%']);
  const playBtn = el('button', { class: 'primary' }, ['▶  Ler']);
  const stopBtn = el('button', { class: 'ghost' }, ['⏹  Parar']);
  const saveBtn = el('button', {}, ['💾  Salvar…']) as HTMLButtonElement;
  const statusPill = el('span', { class: 'pill' }, ['—']);
  const errorBox = el('div', { class: 'error' });
  const saveStatus = el('div', { class: 'hint' });

  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;

  const stopPlayback = () => {
    if (source) {
      try {
        source.stop();
      } catch {
        /* ignore */
      }
      source = null;
    }
  };

  // Valida texto/voz/engine antes de sintetizar. Retorna o texto ou null.
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

    playBtn.disabled = true;
    playBtn.textContent = '⏳  Sintetizando…';
    try {
      const wav = await window.sts.piper.synth(
        text,
        voiceSelect.value,
        parseFloat(rate.value),
      );
      const buf = wav.slice().buffer;
      if (!ctx) ctx = new AudioContext();
      await ctx.resume();
      const audioBuffer = await ctx.decodeAudioData(buf);
      stopPlayback();
      gain = ctx.createGain();
      gain.gain.value = parseFloat(volume.value);
      source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => {
        if (source && !source.buffer) return;
      };
      source.start();
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      playBtn.disabled = false;
      playBtn.textContent = '▶  Ler';
    }
  };

  const save = async () => {
    const text = await ensureReady();
    if (!text) return;
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳  Salvando…';
    try {
      const res = await window.sts.piper.export(
        text,
        voiceSelect.value,
        parseFloat(rate.value),
      );
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
    if (gain) gain.gain.value = v; // ajuste ao vivo
  });
  volume.addEventListener('change', () =>
    window.sts.settings.set({ ttsVolume: parseFloat(volume.value) }),
  );
  voiceSelect.addEventListener('change', () =>
    window.sts.settings.set({ piperVoice: voiceSelect.value }),
  );
  playBtn.addEventListener('click', play);
  stopBtn.addEventListener('click', stopPlayback);
  saveBtn.addEventListener('click', save);

  const element = el('div', { class: 'panel', id: 'panel-read' }, [
    el('h2', {}, ['Ler']),
    el('p', { class: 'sub' }, [
      'Digite um texto e ouça a leitura com voz neural local (Piper).',
    ]),
    el('div', { class: 'card' }, [textarea]),
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('label', { class: 'field', style: 'flex:2' }, ['Voz', voiceSelect]),
        el('label', { class: 'field' }, [
          el('span', {}, ['Velocidade ', rateVal]),
          rate,
        ]),
        el('label', { class: 'field' }, [
          el('span', {}, ['Volume ', volVal]),
          volume,
        ]),
      ]),
      el('div', { class: 'row' }, [
        playBtn,
        stopBtn,
        saveBtn,
        el('span', { style: 'flex:1' }),
        statusPill,
      ]),
      saveStatus,
    ]),
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
      for (const v of installed) {
        voiceSelect.append(el('option', { value: v.id }, [v.label]));
      }
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
  };

  return { element, refresh };
}
