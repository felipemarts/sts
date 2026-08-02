import { el } from './dom';
import { Tab } from './listen';
import { startRecording, RecordController } from './recorder';

const REC_MS = 10000;

export function createCloneTab(): Tab {
  // --- Engine ---
  const enginePill = el('span', { class: 'pill' }, ['—']);
  const installBtn = el('button', {}, ['Instalar clonagem']) as HTMLButtonElement;
  const engineHint = el('div', { class: 'hint' });
  const setupLog = el('div', { class: 'hint', style: 'margin-top:8px' });

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    setupLog.textContent = 'Iniciando…';
    try {
      await window.sts.clone.setup();
    } catch (err) {
      setupLog.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      installBtn.disabled = false;
      refresh();
    }
  });
  window.sts.clone.onSetupProgress((p) => {
    setupLog.textContent = p.message;
    if (p.done && !p.error && p.stage !== 'model') refresh();
  });

  // --- Amostra de referência ---
  const recBtn = el('button', { class: 'primary' }, ['● Gravar amostra (10s)']) as HTMLButtonElement;
  const recMeterFill = el('div');
  const recMeter = el('div', { class: 'meter' }, [recMeterFill]);
  const recStatus = el('span', { class: 'pill' }, ['sem amostra']);
  let rec: RecordController | null = null;

  const finishRec = async (pcm: Float32Array, sampleRate: number) => {
    recBtn.textContent = '⏳ Salvando amostra…';
    try {
      await window.sts.clone.saveReference(pcm.buffer as ArrayBuffer, sampleRate);
      recStatus.textContent = 'amostra pronta';
      recStatus.className = 'pill ok';
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      rec = null;
      recBtn.textContent = '● Regravar amostra (10s)';
      recBtn.classList.remove('rec');
      recBtn.classList.add('primary');
      recMeterFill.style.width = '0%';
    }
  };

  recBtn.addEventListener('click', async () => {
    if (rec) {
      rec.stop();
      return;
    }
    errorBox.textContent = '';
    const s = await window.sts.settings.get();
    try {
      recBtn.classList.add('rec');
      recBtn.classList.remove('primary');
      rec = await startRecording({
        deviceId: s.micDeviceId,
        maxDurationMs: REC_MS,
        onLevel: (r) => (recMeterFill.style.width = `${Math.min(100, (r / 0.3) * 100)}%`),
        onTick: (ms) => (recBtn.textContent = `⏹ Parar — ${(ms / 1000).toFixed(1)}s / 10s`),
      });
      const { pcm, sampleRate } = await rec.done;
      await finishRec(pcm, sampleRate);
    } catch (err) {
      errorBox.textContent =
        'Falha ao acessar o microfone: ' + (err instanceof Error ? err.message : String(err));
      rec = null;
      recBtn.textContent = '● Gravar amostra (10s)';
      recBtn.classList.remove('rec');
      recBtn.classList.add('primary');
    }
  });

  // --- Síntese ---
  const langSelect = el('select', {}, []) as HTMLSelectElement;
  for (const [v, l] of [
    ['pt', 'Português'],
    ['en', 'Inglês'],
    ['es', 'Espanhol'],
    ['fr', 'Francês'],
    ['de', 'Alemão'],
    ['it', 'Italiano'],
  ]) {
    langSelect.append(el('option', { value: v }, [l]));
  }
  langSelect.addEventListener('change', () =>
    window.sts.settings.set({ cloneLanguage: langSelect.value }),
  );

  const textarea = el('textarea', {
    placeholder: 'Digite o texto para falar com a voz clonada…',
  }) as HTMLTextAreaElement;
  const volume = el('input', {
    type: 'range', min: '0', max: '1', step: '0.05', value: '1',
  }) as HTMLInputElement;
  const volVal = el('span', { class: 'value' }, ['100%']);
  const playBtn = el('button', { class: 'primary' }, ['▶  Ler com voz clonada']) as HTMLButtonElement;
  const saveBtn = el('button', {}, ['💾  Salvar…']) as HTMLButtonElement;
  const errorBox = el('div', { class: 'error' });
  const saveStatus = el('div', { class: 'hint' });

  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;

  volume.addEventListener('input', () => {
    const v = parseFloat(volume.value);
    volVal.textContent = `${Math.round(v * 100)}%`;
    if (gain) gain.gain.value = v;
  });

  const ready = async (): Promise<string | null> => {
    errorBox.textContent = '';
    saveStatus.textContent = '';
    const text = textarea.value.trim();
    if (!text) return null;
    const ens = await window.sts.clone.ensure();
    if (!ens.installed) {
      errorBox.textContent = 'Instale a clonagem primeiro (botão acima).';
      return null;
    }
    if (!ens.hasReference) {
      errorBox.textContent = 'Grave uma amostra de referência primeiro.';
      return null;
    }
    return text;
  };

  playBtn.addEventListener('click', async () => {
    const text = await ready();
    if (!text) return;
    playBtn.disabled = true;
    playBtn.textContent = '⏳  Sintetizando…';
    try {
      const wav = await window.sts.clone.synth(text, langSelect.value);
      if (!ctx) ctx = new AudioContext();
      await ctx.resume();
      const audioBuffer = await ctx.decodeAudioData(wav.slice().buffer);
      if (source) try { source.stop(); } catch { /* ignore */ }
      gain = ctx.createGain();
      gain.gain.value = parseFloat(volume.value);
      source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      playBtn.disabled = false;
      playBtn.textContent = '▶  Ler com voz clonada';
    }
  });

  saveBtn.addEventListener('click', async () => {
    const text = await ready();
    if (!text) return;
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳  Salvando…';
    try {
      const res = await window.sts.clone.export(text, langSelect.value);
      if (!res.canceled && res.path) saveStatus.textContent = `✓ Salvo em: ${res.path}`;
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾  Salvar…';
    }
  });

  const element = el('div', { class: 'panel', id: 'panel-clone' }, [
    el('h2', {}, ['Clonar voz']),
    el('p', { class: 'sub' }, [
      'Grave uma amostra da sua voz e sintetize qualquer texto com ela (Chatterbox, local). Recurso avançado — mais pesado que o Piper.',
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Motor de clonagem']),
      el('div', { class: 'row' }, [enginePill, installBtn]),
      engineHint,
      setupLog,
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Amostra de referência']),
      el('p', { class: 'hint' }, ['Grave ~10s falando naturalmente. Sem ruído de fundo, uma voz só.']),
      el('div', { class: 'row' }, [recBtn, recMeter, recStatus]),
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Falar com a voz clonada']),
      el('div', { class: 'row' }, [
        el('label', { class: 'field' }, ['Idioma', langSelect]),
        el('label', { class: 'field' }, [el('span', {}, ['Volume ', volVal]), volume]),
      ]),
      textarea,
      el('div', { class: 'row', style: 'margin-top:12px' }, [playBtn, saveBtn]),
      el('p', { class: 'hint', style: 'margin-top:8px' }, [
        '⏳ Roda em CPU: a 1ª síntese carrega o modelo (~30s) e cada frase leva ~1–2 min. Tenha paciência — não travou.',
      ]),
      saveStatus,
    ]),
    errorBox,
  ]);

  async function refresh() {
    const s = await window.sts.settings.get();
    langSelect.value = s.cloneLanguage;
    volume.value = String(s.ttsVolume);
    volVal.textContent = `${Math.round(s.ttsVolume * 100)}%`;

    const ens = await window.sts.clone.ensure();
    if (ens.installed) {
      enginePill.textContent = 'Clonagem pronta';
      enginePill.className = 'pill ok';
      engineHint.textContent = '';
      installBtn.style.display = 'none';
    } else if (!ens.python311) {
      enginePill.textContent = 'Python 3.11 não encontrado';
      enginePill.className = 'pill bad';
      engineHint.textContent = 'Instale com: brew install python@3.11 e reabra o app.';
      installBtn.style.display = 'none';
    } else {
      enginePill.textContent = 'Não instalado';
      enginePill.className = 'pill bad';
      engineHint.textContent = 'Baixa chatterbox-tts + PyTorch (~2–3 GB) num venv isolado.';
      installBtn.style.display = '';
    }

    if (ens.hasReference) {
      recStatus.textContent = 'amostra pronta';
      recStatus.className = 'pill ok';
      recBtn.textContent = '● Regravar amostra (10s)';
    } else {
      recStatus.textContent = 'sem amostra';
      recStatus.className = 'pill';
    }
  }

  return { element, refresh };
}
