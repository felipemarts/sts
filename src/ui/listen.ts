import { el } from './dom';
import { startCapture, CaptureHandle } from './audioCapture';
import { findWhisper } from '../backend/models/catalog';

export interface Tab {
  element: HTMLElement;
  refresh: () => void | Promise<void>;
}

export function createListenTab(goToSettings: () => void): Tab {
  const statusPill = el('span', { class: 'pill' }, ['—']);
  const startBtn = el('button', { class: 'primary' }, ['▶  Iniciar captura']);
  const clearBtn = el('button', { class: 'ghost' }, ['Limpar']);
  const copyBtn = el('button', { class: 'ghost' }, ['Copiar']);
  const meterFill = el('div');
  const meter = el('div', { class: 'meter' }, [meterFill]);
  const transcript = el('div', { class: 'transcript' });
  const interim = el('span', { class: 'interim' });
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
  let finalText = '';
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let gotChunk = false;
  let maxLevel = 0;
  let signalTimer: ReturnType<typeof setTimeout> | null = null;

  langSelect.addEventListener('change', () => {
    window.sts.settings.set({ whisperLanguage: langSelect.value });
  });

  const render = () => {
    transcript.textContent = finalText ? finalText + ' ' : '';
    if (pending > 0) {
      interim.textContent = '● transcrevendo…';
      transcript.append(interim);
    }
  };

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
        if (text) finalText = finalText ? `${finalText} ${text}` : text;
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
      await handle.stop();
      handle = null;
    }
    window.sts.whisper.stop();
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
          const pct = Math.min(100, (rms / 0.3) * 100);
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
    finalText = '';
    errorBox.textContent = '';
    render();
  });
  copyBtn.addEventListener('click', () => navigator.clipboard.writeText(finalText));

  const element = el('div', { class: 'panel', id: 'panel-listen' }, [
    el('h2', {}, ['Escutar']),
    el('p', { class: 'sub' }, [
      'Fale ao microfone e veja a transcrição aparecer em tempo real (Whisper local).',
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        startBtn,
        clearBtn,
        copyBtn,
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
    el('div', { class: 'card' }, [transcript]),
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
