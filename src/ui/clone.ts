import { el } from './dom';
import { Tab } from './listen';
import { startRecording, RecordController } from './recorder';

const REC_MS = 15000;
const QA_THRESHOLD = 0.34; // WER acima disso = frase provavelmente embolada → regerar
const MAX_ATTEMPTS = 3; // tentativas por frase quando o QA reprova
const GAP_S = 0.25; // silêncio entre frases ao concatenar

type SegStatus = 'pending' | 'gen' | 'qa' | 'ok' | 'warn' | 'error' | 'stale' | 'user' | 'rec';

/** Codifica PCM float32 mono em bytes WAV 16-bit (para a gravação do usuário). */
function encodeWavJs(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * bytesPerSample, true);
  dv.setUint16(32, bytesPerSample, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

interface Seg {
  text: string; // texto atual (editável)
  genText: string; // texto da última geração
  status: SegStatus;
  wav: Uint8Array | null;
  buffer: AudioBuffer | null;
  wer: number | null;
  heard: string;
  card: HTMLElement;
  chip: HTMLElement;
  ta: HTMLTextAreaElement;
  note: HTMLElement;
  playBtn: HTMLButtonElement;
  recBtn: HTMLButtonElement;
  regenBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Quebra o texto em frases (uma por segmento). */
function splitSentences(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const src = paras.length ? paras : [text];
  const out: string[] = [];
  for (const p of src) {
    for (const s of p.match(/[^.!?…]+[.!?…]*(\s+|$)/g) || [p]) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function normWords(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Word Error Rate (Levenshtein por palavras). */
function wordErrorRate(ref: string, hyp: string): number {
  const r = normWords(ref);
  const h = normWords(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 0; i <= r.length; i++) d[i][0] = i;
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const c = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    }
  }
  return d[r.length][h.length] / Math.max(1, r.length);
}

/** Reamostra float32 para 16 kHz (para a conferência com o Whisper). */
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

export function createCloneTab(): Tab {
  // ------------------------------ Engine ------------------------------
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

  // ------------------------- Amostra de referência -------------------------
  const recBtn = el('button', { class: 'primary' }, ['● Gravar amostra (até 15s)']) as HTMLButtonElement;
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
      recBtn.textContent = '● Regravar amostra (até 15s)';
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
        onTick: (ms) => (recBtn.textContent = `⏹ Parar — ${(ms / 1000).toFixed(1)}s / 15s`),
      });
      const { pcm, sampleRate } = await rec.done;
      await finishRec(pcm, sampleRate);
    } catch (err) {
      errorBox.textContent =
        'Falha ao acessar o microfone: ' + (err instanceof Error ? err.message : String(err));
      rec = null;
      recBtn.textContent = '● Gravar amostra (até 15s)';
      recBtn.classList.remove('rec');
      recBtn.classList.add('primary');
    }
  });

  // ------------------------------ Estúdio ------------------------------
  const langSelect = el('select', {}, []) as HTMLSelectElement;
  for (const [v, l] of [
    ['pt', 'Português'], ['en', 'Inglês'], ['es', 'Espanhol'],
    ['fr', 'Francês'], ['de', 'Alemão'], ['it', 'Italiano'],
  ]) {
    langSelect.append(el('option', { value: v }, [l]));
  }
  langSelect.addEventListener('change', () =>
    window.sts.settings.set({ cloneLanguage: langSelect.value }),
  );

  const poolSelect = el('select', {}, []) as HTMLSelectElement;
  for (const n of ['1', '2', '3']) {
    poolSelect.append(el('option', { value: n }, [`${n} gerador${n === '1' ? '' : 'es'}`]));
  }
  poolSelect.addEventListener('change', () =>
    window.sts.settings.set({ clonePoolSize: parseInt(poolSelect.value, 10) }),
  );

  const qaCheck = el('input', { type: 'checkbox' }) as HTMLInputElement;
  qaCheck.checked = true;
  const volume = el('input', {
    type: 'range', min: '0', max: '1', step: '0.05', value: '1',
  }) as HTMLInputElement;
  const volVal = el('span', { class: 'value' }, ['100%']);

  const textarea = el('textarea', {
    placeholder: 'Cole um texto (curto ou longo). Ele é quebrado em frases e gerado uma a uma, com conferência automática.',
  }) as HTMLTextAreaElement;

  const genBtn = el('button', { class: 'primary' }, ['🧬  Gerar']) as HTMLButtonElement;
  const playAllBtn = el('button', { class: 'ghost' }, ['▶  Ouvir tudo']) as HTMLButtonElement;
  const pauseBtn = el('button', { class: 'ghost' }, ['⏸  Pausar']) as HTMLButtonElement;
  const stopBtn = el('button', { class: 'ghost' }, ['⏹  Parar']) as HTMLButtonElement;
  const saveAllBtn = el('button', {}, ['💾  Salvar tudo']) as HTMLButtonElement;
  const genStatus = el('span', { class: 'pill' }, ['—']);
  const segList = el('div', { class: 'segments' });
  const errorBox = el('div', { class: 'error' });
  const saveStatus = el('div', { class: 'hint' });

  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;

  let segments: Seg[] = [];
  let generating = false;
  let genCancel = false;
  let recSeg: Seg | null = null; // frase gravando agora (só uma por vez)
  let recCtl: RecordController | null = null;
  let playRun = 0; // invalida "ouvir tudo" ao parar/regerar
  let playing = false;
  let paused = false;
  let qaAvailable = false;

  const audioCtx = () => {
    if (!ctx) ctx = new AudioContext();
    return ctx;
  };
  const decode = (wav: Uint8Array): Promise<AudioBuffer> =>
    audioCtx().decodeAudioData(wav.slice().buffer);

  volume.addEventListener('input', () => {
    const v = parseFloat(volume.value);
    volVal.textContent = `${Math.round(v * 100)}%`;
    if (gain) gain.gain.value = v;
  });

  // ---- status/labels dos botões globais ----
  const anyReady = () => segments.some((s) => s.buffer && s.status !== 'stale');
  const doneCount = () => segments.filter((s) => s.status === 'ok' || s.status === 'warn').length;

  const updateGlobal = () => {
    genBtn.disabled = false;
    genBtn.textContent = generating ? '⏹  Parar geração' : '🧬  Gerar';
    genBtn.classList.toggle('rec', generating);
    playAllBtn.disabled = !anyReady() || playing;
    pauseBtn.disabled = !playing;
    stopBtn.disabled = !playing;
    saveAllBtn.disabled = !segments.length || segments.some((s) => !s.buffer);
    pauseBtn.textContent = paused ? '▶  Retomar' : '⏸  Pausar';
    if (segments.length) {
      const warn = segments.filter((s) => s.status === 'warn').length;
      genStatus.textContent = generating
        ? `gerando ${doneCount()}/${segments.length}…`
        : `${segments.length} frase(s)${warn ? ` · ${warn} c/ atenção` : ''}`;
      genStatus.className = warn ? 'pill warn' : segments.length ? 'pill ok' : 'pill';
    } else {
      genStatus.textContent = '—';
      genStatus.className = 'pill';
    }
  };

  const CHIP: Record<SegStatus, [string, string]> = {
    pending: ['na fila', 'pill'],
    gen: ['gerando…', 'pill'],
    qa: ['conferindo…', 'pill'],
    ok: ['✓', 'pill ok'],
    warn: ['⚠ atenção', 'pill warn'],
    error: ['erro', 'pill bad'],
    stale: ['refazer', 'pill warn'],
    user: ['🎙 sua voz', 'pill ok'],
    rec: ['● gravando…', 'pill warn'],
  };

  const renderSeg = (seg: Seg) => {
    const [txt, cls] = CHIP[seg.status];
    seg.chip.textContent = txt;
    seg.chip.className = cls;
    const stale = seg.status === 'stale';
    const recording = seg.status === 'rec';
    const busyElsewhere = recSeg !== null && recSeg !== seg;
    seg.playBtn.disabled = recording || !seg.buffer || stale;
    seg.saveBtn.disabled = recording || !seg.wav || stale;
    seg.regenBtn.disabled = recording || busyElsewhere || (generating && seg.status !== 'stale');
    seg.recBtn.disabled = busyElsewhere;
    seg.recBtn.textContent = recording ? '⏹' : '🎙';
    seg.recBtn.classList.toggle('rec', recording);
    seg.card.classList.toggle('warn', seg.status === 'warn');
    seg.card.classList.toggle('recording', recording);
    if (seg.status === 'warn' && seg.heard) {
      seg.note.textContent = `Whisper ouviu: “${seg.heard}” (${Math.round((seg.wer ?? 0) * 100)}% de diferença)`;
      seg.note.style.display = '';
    } else {
      seg.note.style.display = 'none';
    }
    updateGlobal();
  };

  const makeSeg = (text: string, index: number): Seg => {
    const chip = el('span', { class: 'pill' }, ['na fila']);
    const ta = el('textarea', { class: 'seg-text', rows: '2' }) as HTMLTextAreaElement;
    ta.value = text;
    const note = el('div', { class: 'hint', style: 'display:none' });
    const playBtn = el('button', { class: 'ghost mini', title: 'Ouvir esta frase' }, ['▶']) as HTMLButtonElement;
    const recBtn = el('button', { class: 'ghost mini', title: 'Gravar SUA voz nesta frase' }, ['🎙']) as HTMLButtonElement;
    const regenBtn = el('button', { class: 'ghost mini', title: 'Regerar (voz clonada)' }, ['↻']) as HTMLButtonElement;
    const saveBtn = el('button', { class: 'ghost mini', title: 'Salvar esta frase' }, ['💾']) as HTMLButtonElement;
    const card = el('div', { class: 'seg' }, [
      el('div', { class: 'seg-head' }, [
        el('span', { class: 'seg-idx' }, [`${index + 1}`]),
        chip,
        el('span', { style: 'flex:1' }),
        playBtn, recBtn, regenBtn, saveBtn,
      ]),
      ta,
      note,
    ]);
    const seg: Seg = {
      text, genText: '', status: 'pending', wav: null, buffer: null, wer: null, heard: '',
      card, chip, ta, note, playBtn, recBtn, regenBtn, saveBtn,
    };
    ta.addEventListener('input', () => {
      seg.text = ta.value.trim();
      // gravação do usuário não é invalidada ao editar o texto (é a voz dele).
      if (seg.buffer && seg.text !== seg.genText && seg.status !== 'user' && seg.status !== 'rec') {
        seg.status = 'stale';
        renderSeg(seg);
      }
    });
    playBtn.addEventListener('click', () => playSegment(seg));
    recBtn.addEventListener('click', () => recordSegment(seg));
    saveBtn.addEventListener('click', () => saveSegment(seg, index));
    regenBtn.addEventListener('click', async () => {
      if (generating || recSeg) return;
      seg.text = ta.value.trim();
      if (!seg.text) return;
      await processSegment(seg);
    });
    return seg;
  };

  // ---- QA: transcreve o áudio gerado e mede a diferença ----
  async function runQa(buffer: AudioBuffer, expected: string): Promise<{ wer: number; heard: string }> {
    const pcm16 = resampleTo16k(buffer.getChannelData(0), buffer.sampleRate);
    const heard = await window.sts.whisper.transcribe(pcm16.buffer as ArrayBuffer, 16000, langSelect.value);
    return { wer: wordErrorRate(expected, heard), heard };
  }

  // ---- gera uma frase: síntese + conferência + retry, guardando a melhor ----
  async function processSegment(seg: Seg) {
    seg.wav = null;
    seg.buffer = null;
    seg.status = 'gen';
    renderSeg(seg);
    const useQa = qaAvailable && qaCheck.checked;
    let best: { wer: number; wav: Uint8Array; buffer: AudioBuffer; heard: string } | null = null;
    try {
      for (let attempt = 0; attempt < (useQa ? MAX_ATTEMPTS : 1); attempt++) {
        seg.status = 'gen';
        renderSeg(seg);
        const wav = await window.sts.clone.synthSegment(seg.text, langSelect.value);
        const buffer = await decode(wav);
        let wer = 0;
        let heard = '';
        if (useQa) {
          seg.status = 'qa';
          renderSeg(seg);
          try {
            const r = await runQa(buffer, seg.text);
            wer = r.wer;
            heard = r.heard;
          } catch {
            wer = 0; // conferência falhou → aceita
          }
        }
        if (!best || wer < best.wer) best = { wer, wav, buffer, heard };
        if (wer <= QA_THRESHOLD) break;
      }
      if (!best) throw new Error('Falha na geração.');
      seg.wav = best.wav;
      seg.buffer = best.buffer;
      seg.wer = best.wer;
      seg.heard = best.heard;
      seg.genText = seg.text;
      seg.status = best.wer <= QA_THRESHOLD ? 'ok' : 'warn';
    } catch (err) {
      if (genCancel) {
        seg.status = seg.buffer ? 'ok' : 'pending'; // cancelado: sem erro assustador
      } else {
        seg.status = 'error';
        errorBox.textContent = err instanceof Error ? err.message : String(err);
      }
    }
    renderSeg(seg);
  }

  // ---- gravar a PRÓPRIA voz para uma frase (substitui a geração) ----
  async function recordSegment(seg: Seg) {
    if (recSeg === seg) {
      recCtl?.stop();
      return;
    }
    if (recSeg || generating) return;
    errorBox.textContent = '';
    const prev = seg.status;
    const s = await window.sts.settings.get();
    let ok = false;
    try {
      recSeg = seg;
      seg.status = 'rec';
      segments.forEach(renderSeg);
      recCtl = await startRecording({
        deviceId: s.micDeviceId,
        maxDurationMs: 30000,
        onTick: (ms) => { seg.recBtn.textContent = `⏹ ${(ms / 1000).toFixed(1)}s`; },
      });
      const { pcm, sampleRate } = await recCtl.done;
      if (pcm.length >= sampleRate * 0.2) {
        const wav = encodeWavJs(pcm, sampleRate);
        seg.wav = wav;
        seg.buffer = await decode(wav);
        seg.genText = seg.text;
        seg.status = 'user';
        ok = true;
      }
    } catch (err) {
      errorBox.textContent = 'Falha ao gravar: ' + (err instanceof Error ? err.message : String(err));
    } finally {
      if (!ok) seg.status = prev === 'rec' ? (seg.buffer ? 'user' : 'pending') : prev;
      recSeg = null;
      recCtl = null;
      segments.forEach(renderSeg);
    }
  }

  // ---- gerar tudo (com paralelismo = clonePoolSize) ----
  async function generateAll() {
    if (generating) return;
    errorBox.textContent = '';
    saveStatus.textContent = '';
    const text = textarea.value.trim();
    if (!text) return;
    const ens = await window.sts.clone.ensure();
    if (!ens.installed) {
      errorBox.textContent = 'Instale a clonagem primeiro (botão acima).';
      return;
    }
    if (!ens.hasReference) {
      errorBox.textContent = 'Grave uma amostra de referência primeiro.';
      return;
    }

    stopPlay();
    const sentences = splitSentences(text);
    segments = sentences.map((s, i) => makeSeg(s, i));
    segList.innerHTML = '';
    for (const s of segments) segList.append(s.card);

    generating = true;
    genCancel = false;
    updateGlobal();
    const poolSize = Math.max(1, Math.min(3, parseInt(poolSelect.value, 10) || 1));

    let next = 0;
    const lane = async () => {
      while (next < segments.length && !genCancel) {
        const i = next++;
        await processSegment(segments[i]);
      }
    };
    try {
      await Promise.all(Array.from({ length: poolSize }, () => lane()));
    } finally {
      generating = false;
      genCancel = false;
      updateGlobal();
    }
  }

  // Cancela a geração em andamento (mata os workers; o pool respawna na próxima).
  async function cancelGen() {
    if (!generating) return;
    genCancel = true;
    genStatus.textContent = 'cancelando…';
    try {
      await window.sts.clone.stop();
    } catch {
      /* ignore */
    }
  }

  // ------------------------------ Playback ------------------------------
  const stopSource = () => {
    if (source) {
      try { source.stop(); } catch { /* ignore */ }
      source = null;
    }
  };
  const clearActive = () => segments.forEach((s) => s.card.classList.remove('active'));

  const playBuffer = (buf: AudioBuffer): Promise<void> =>
    new Promise((resolve) => {
      const c = audioCtx();
      gain = c.createGain();
      gain.gain.value = parseFloat(volume.value);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      gain.connect(c.destination);
      source = src;
      src.onended = () => {
        if (source === src) source = null;
        resolve();
      };
      src.start();
    });

  async function playSegment(seg: Seg) {
    if (!seg.buffer) return;
    stopPlay();
    const c = audioCtx();
    if (c.state === 'suspended') await c.resume();
    playing = true;
    paused = false;
    playRun++;
    clearActive();
    seg.card.classList.add('active');
    updateGlobal();
    await playBuffer(seg.buffer);
    seg.card.classList.remove('active');
    playing = false;
    updateGlobal();
  }

  async function playAll() {
    stopSource();
    const c = audioCtx();
    if (c.state === 'suspended') await c.resume();
    const myRun = ++playRun;
    playing = true;
    paused = false;
    updateGlobal();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      // reprodução progressiva: espera a frase ficar pronta (ou pula erro/stale).
      while (myRun === playRun && !seg.buffer && seg.status !== 'error' && seg.status !== 'stale') {
        await sleep(200);
      }
      if (myRun !== playRun) return;
      if (!seg.buffer) continue;
      clearActive();
      seg.card.classList.add('active');
      seg.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      await playBuffer(seg.buffer);
      if (myRun !== playRun) return;
    }
    clearActive();
    playing = false;
    updateGlobal();
  }

  function stopPlay() {
    playRun++;
    if (ctx && ctx.state === 'suspended') ctx.resume();
    paused = false;
    stopSource();
    playing = false;
    clearActive();
    updateGlobal();
  }

  async function togglePause() {
    if (!playing || !ctx) return;
    if (paused) { await ctx.resume(); paused = false; }
    else { await ctx.suspend(); paused = true; }
    updateGlobal();
  }

  // ------------------------------ Salvar ------------------------------
  async function saveSegment(seg: Seg, index: number) {
    if (!seg.wav) return;
    saveStatus.textContent = '';
    try {
      const res = await window.sts.saveAudio(seg.wav.slice().buffer as ArrayBuffer, `frase-${index + 1}.wav`);
      if (!res.canceled && res.path) saveStatus.textContent = `✓ Salvo: ${res.path}`;
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  async function saveAll() {
    const ready = segments.filter((s) => s.buffer);
    if (!ready.length) return;
    saveStatus.textContent = '';
    // concatena o PCM (todos no sampleRate do AudioContext) com silêncio entre frases
    const sr = ready[0].buffer!.sampleRate;
    const gap = Math.floor(sr * GAP_S);
    let total = 0;
    for (const s of ready) total += s.buffer!.length + gap;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const s of ready) {
      pcm.set(s.buffer!.getChannelData(0), off);
      off += s.buffer!.length + gap;
    }
    try {
      const res = await window.sts.saveWavFromPcm(pcm.buffer as ArrayBuffer, sr, 'voz-clonada.wav');
      if (!res.canceled && res.path) saveStatus.textContent = `✓ Salvo: ${res.path}`;
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  genBtn.addEventListener('click', () => (generating ? cancelGen() : generateAll()));
  playAllBtn.addEventListener('click', playAll);
  pauseBtn.addEventListener('click', togglePause);
  stopBtn.addEventListener('click', stopPlay);
  saveAllBtn.addEventListener('click', saveAll);

  const element = el('div', { class: 'panel', id: 'panel-clone' }, [
    el('h2', {}, ['Clonar voz']),
    el('p', { class: 'sub' }, [
      'Grave uma amostra e gere qualquer texto com ela. Textos longos são quebrados em frases, geradas uma a uma com conferência automática (o app transcreve o áudio de volta e regenera as frases que embolarem).',
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Motor de clonagem']),
      el('div', { class: 'row' }, [enginePill, installBtn]),
      engineHint,
      setupLog,
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Amostra de referência']),
      el('p', { class: 'hint' }, ['Grave ~10–15s falando com boa dicção, sem ruído de fundo, uma voz só. O modelo usa só os ~10s iniciais — amostra mais longa não ajuda; o que conta é a qualidade e clareza do trecho.']),
      el('div', { class: 'row' }, [recBtn, recMeter, recStatus]),
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Texto']),
      el('div', { class: 'row' }, [
        el('label', { class: 'field' }, ['Idioma', langSelect]),
        el('label', { class: 'field' }, ['Paralelismo', poolSelect]),
        el('label', { class: 'field' }, [el('span', {}, ['Volume ', volVal]), volume]),
        el('label', { class: 'field', style: 'flex-direction:row;align-items:center;gap:6px;flex:0 0 auto' }, [
          qaCheck, el('span', {}, ['Conferir (Whisper)']),
        ]),
      ]),
      textarea,
      el('div', { class: 'row', style: 'margin-top:12px' }, [
        genBtn, playAllBtn, pauseBtn, stopBtn, saveAllBtn,
        el('span', { style: 'flex:1' }),
        genStatus,
      ]),
      el('p', { class: 'hint', style: 'margin-top:6px' }, [
        'Roda em CPU: ~30s p/ carregar o modelo na 1ª vez + ~30s–1min por frase. Você já pode ouvir as primeiras frases enquanto o resto gera. ',
        'Dica: em CPU, Paralelismo = 1 costuma ser o mais RÁPIDO (2–3 geradores dividem a CPU e ficam mais lentos, além de usar 2–3× a RAM). Use >1 só se sobrarem núcleos e RAM.',
      ]),
      saveStatus,
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, ['Frases']),
      el('p', { class: 'hint' }, [
        'Em cada frase: ▶ ouvir · 🎙 gravar a SUA voz (para dar um tom ou substituir uma geração ruim) · ↻ regerar (voz clonada) · 💾 salvar. A gravação sua entra no "Ouvir tudo" e no "Salvar tudo".',
      ]),
      segList,
    ]),
    errorBox,
  ]);

  async function refresh() {
    const s = await window.sts.settings.get();
    langSelect.value = s.cloneLanguage;
    poolSelect.value = String(s.clonePoolSize || 1);
    volume.value = String(s.ttsVolume);
    volVal.textContent = `${Math.round(s.ttsVolume * 100)}%`;

    // QA disponível se há binário + modelo Whisper (aba Escutar)
    try {
      const eng = await window.sts.engines.status();
      const st = await window.sts.models.status();
      qaAvailable = eng.whisper.available && !!s.whisperModel && !!st[s.whisperModel];
    } catch {
      qaAvailable = false;
    }
    qaCheck.disabled = !qaAvailable;
    if (!qaAvailable) qaCheck.checked = false;

    const ens = await window.sts.clone.ensure();
    if (ens.installed) {
      enginePill.textContent = 'Clonagem pronta';
      enginePill.className = 'pill ok';
      engineHint.textContent = '';
      installBtn.style.display = 'none';
    } else {
      enginePill.textContent = 'Não instalado';
      enginePill.className = 'pill bad';
      engineHint.textContent = ens.pythonRuntimeReady
        ? 'Baixa chatterbox-tts + PyTorch (~2–3 GB) num venv isolado.'
        : 'Baixa um Python 3.11 embutido + chatterbox-tts + PyTorch (~2–3 GB). Não precisa de Python no sistema.';
      installBtn.style.display = '';
    }

    if (ens.hasReference) {
      recStatus.textContent = 'amostra pronta';
      recStatus.className = 'pill ok';
      recBtn.textContent = '● Regravar amostra (até 15s)';
    } else {
      recStatus.textContent = 'sem amostra';
      recStatus.className = 'pill';
    }
    updateGlobal();
  }

  return { element, refresh };
}
