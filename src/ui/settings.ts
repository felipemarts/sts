import { el, fmtBytes } from './dom';
import { listInputDevices } from './audioCapture';
import { Tab } from './listen';
import { ModelKind } from '../shared/types';

interface RowRef {
  actionBtn: HTMLButtonElement;
  bar: HTMLDivElement;
  barWrap: HTMLElement;
  pill: HTMLSpanElement;
  err: HTMLElement;
}

export function createSettingsTab(onModelsChanged: () => void): Tab {
  const rows = new Map<string, RowRef>();

  // ---- Engines ----
  const whisperPill = el('span', { class: 'pill' }, ['—']);
  const whisperHint = el('div', { class: 'hint' });
  const piperPill = el('span', { class: 'pill' }, ['—']);
  const piperHint = el('div', { class: 'hint' });
  const installPiperBtn = el('button', {}, ['Instalar Piper']) as HTMLButtonElement;
  const piperLog = el('div', { class: 'hint', style: 'margin-top:8px' });

  installPiperBtn.addEventListener('click', async () => {
    installPiperBtn.disabled = true;
    piperLog.textContent = 'Iniciando…';
    try {
      await window.sts.piper.setup();
    } catch (err) {
      piperLog.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      installPiperBtn.disabled = false;
      refreshEngines();
    }
  });

  window.sts.piper.onSetupProgress((p) => {
    piperLog.textContent = p.message;
    if (p.done && !p.error) refreshEngines();
  });

  // ---- Microphone ----
  const micSelect = el('select', {}, []) as HTMLSelectElement;
  const micPermBtn = el('button', { class: 'ghost' }, ['Permitir microfone']);
  micSelect.addEventListener('change', () =>
    window.sts.settings.set({ micDeviceId: micSelect.value || null }),
  );
  micPermBtn.addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await refreshMics();
    } catch {
      /* usuário negou */
    }
  });

  // ---- Whisper model selection ----
  const modelSelect = el('select', {}, []) as HTMLSelectElement;
  modelSelect.addEventListener('change', () =>
    window.sts.settings.set({ whisperModel: modelSelect.value || null }),
  );

  // ---- Model manager lists ----
  const whisperList = el('div', {});
  const piperList = el('div', {});

  function makeRow(kind: ModelKind, id: string, label: string, note: string, sizeBytes: number) {
    const pill = el('span', { class: 'pill' }, ['—']);
    const bar = el('div');
    const barWrap = el('div', { class: 'progress', style: 'display:none' }, [bar]);
    const err = el('div', { class: 'error' });
    const actionBtn = el('button', {}, ['Baixar']) as HTMLButtonElement;

    actionBtn.addEventListener('click', async () => {
      const installed = pill.classList.contains('ok');
      if (installed) {
        await window.sts.models.remove(kind, id);
        setInstalled(id, false);
        onModelsChanged();
      } else {
        actionBtn.disabled = true;
        err.textContent = '';
        barWrap.style.display = 'block';
        bar.style.width = '0%';
        try {
          await window.sts.models.download(kind, id);
        } catch (e) {
          err.textContent = e instanceof Error ? e.message : String(e);
        }
      }
    });

    rows.set(id, { actionBtn, bar, barWrap, pill, err });

    return el('div', { class: 'model' }, [
      el('div', { class: 'info' }, [
        el('div', { class: 'name' }, [label]),
        el('div', { class: 'note' }, [note]),
        barWrap,
        err,
      ]),
      el('span', { class: 'pill' }, [fmtBytes(sizeBytes)]),
      pill,
      actionBtn,
    ]);
  }

  function setInstalled(id: string, installed: boolean) {
    const r = rows.get(id);
    if (!r) return;
    r.pill.textContent = installed ? 'Instalado' : 'Não baixado';
    r.pill.className = installed ? 'pill ok' : 'pill';
    r.actionBtn.textContent = installed ? 'Remover' : 'Baixar';
    r.actionBtn.disabled = false;
    r.barWrap.style.display = 'none';
  }

  window.sts.models.onProgress((p) => {
    const r = rows.get(p.id);
    if (!r) return;
    if (p.error) {
      r.err.textContent = p.error;
      r.barWrap.style.display = 'none';
      r.actionBtn.disabled = false;
      return;
    }
    if (p.done) {
      setInstalled(p.id, true);
      refreshModelSelect();
      onModelsChanged();
    } else {
      const pct = p.totalBytes ? (p.receivedBytes / p.totalBytes) * 100 : 0;
      r.bar.style.width = `${pct.toFixed(1)}%`;
    }
  });

  async function refreshEngines() {
    const st = await window.sts.engines.status();
    if (st.whisper.available) {
      whisperPill.textContent = 'whisper.cpp encontrado';
      whisperPill.className = 'pill ok';
      whisperHint.textContent = st.whisper.binaryPath ?? '';
    } else {
      whisperPill.textContent = 'whisper.cpp não encontrado';
      whisperPill.className = 'pill bad';
      whisperHint.textContent =
        'Instale com: brew install whisper-cpp  (ou defina o caminho do binário whisper-server).';
    }

    const ensured = await window.sts.piper.ensure();
    if (ensured.piperInstalled) {
      piperPill.textContent = 'Piper pronto';
      piperPill.className = 'pill ok';
      piperHint.textContent = '';
      installPiperBtn.style.display = 'none';
    } else if (!ensured.systemPython) {
      piperPill.textContent = 'Python 3 não encontrado';
      piperPill.className = 'pill bad';
      piperHint.textContent = 'Instale o Python 3 (ex.: brew install python) para usar o Piper.';
      installPiperBtn.style.display = 'none';
    } else {
      piperPill.textContent = 'Piper não instalado';
      piperPill.className = 'pill bad';
      piperHint.textContent = 'Cria um venv isolado e instala o piper-tts (~35 MB).';
      installPiperBtn.style.display = '';
    }
  }

  async function refreshMics() {
    const s = await window.sts.settings.get();
    const devices = await listInputDevices();
    micSelect.innerHTML = '';
    micSelect.append(el('option', { value: '' }, ['Padrão do sistema']));
    let hasLabels = false;
    for (const d of devices) {
      if (d.label) hasLabels = true;
      micSelect.append(
        el('option', { value: d.deviceId }, [d.label || `Microfone ${d.deviceId.slice(0, 6)}`]),
      );
    }
    if (s.micDeviceId) micSelect.value = s.micDeviceId;
    micPermBtn.style.display = hasLabels ? 'none' : '';
  }

  async function refreshModelSelect() {
    const s = await window.sts.settings.get();
    const cat = await window.sts.catalog();
    const status = await window.sts.models.status();
    modelSelect.innerHTML = '';
    const installed = cat.whisper.filter((m) => status[m.id]);
    if (installed.length === 0) {
      modelSelect.append(el('option', { value: '' }, ['(baixe um modelo abaixo)']));
    } else {
      for (const m of installed) modelSelect.append(el('option', { value: m.id }, [m.label]));
      if (s.whisperModel && installed.some((m) => m.id === s.whisperModel)) {
        modelSelect.value = s.whisperModel;
      } else {
        // seleciona o primeiro instalado por padrão
        modelSelect.value = installed[0].id;
        window.sts.settings.set({ whisperModel: installed[0].id });
      }
    }
  }

  async function buildLists() {
    const cat = await window.sts.catalog();
    const status = await window.sts.models.status();
    rows.clear();
    whisperList.innerHTML = '';
    piperList.innerHTML = '';
    for (const m of cat.whisper) {
      whisperList.append(makeRow('whisper', m.id, m.label, m.note ?? '', m.sizeBytes));
    }
    for (const v of cat.piper) {
      piperList.append(
        makeRow('piper', v.id, v.label, `${v.language} · ${v.quality}`, v.sizeBytes),
      );
    }
    for (const [id, installed] of Object.entries(status)) setInstalled(id, installed);
  }

  const element = el('div', { class: 'panel', id: 'panel-settings' }, [
    el('h2', {}, ['Configurações']),
    el('p', { class: 'sub' }, ['Motores locais, microfone e gerenciamento de modelos.']),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Motores']),
      el('div', { class: 'row' }, [el('span', {}, ['Transcrição (STT):']), whisperPill]),
      whisperHint,
      el('div', { class: 'row', style: 'margin-top:12px' }, [
        el('span', {}, ['Leitura (TTS):']),
        piperPill,
        installPiperBtn,
      ]),
      piperHint,
      piperLog,
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Microfone']),
      el('div', { class: 'row' }, [
        el('label', { class: 'field', style: 'flex:2' }, ['Dispositivo de entrada', micSelect]),
        micPermBtn,
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Modelo de transcrição ativo']),
      el('div', { class: 'row' }, [el('label', { class: 'field' }, ['Whisper', modelSelect])]),
    ]),

    el('div', { class: 'card' }, [el('h3', {}, ['Modelos Whisper (STT)']), whisperList]),
    el('div', { class: 'card' }, [el('h3', {}, ['Vozes Piper (TTS)']), piperList]),
  ]);

  const refresh = async () => {
    await buildLists();
    await refreshEngines();
    await refreshMics();
    await refreshModelSelect();
  };

  return { element, refresh };
}
