// src/renderer/renderer.ts
// The live viva: SDK wiring, the render loop, and screen orchestration.
//
// The renderer owns no policy. It decodes packets into a `Snapshot`, hands
// them to the reducer in src/shared/stateMachine.ts, and paints whatever the
// reducer says. That split is what lets the whole adaptive room be unit-tested
// without a camera.

import {
  SmartSpectraSDK,
  ProcessingStatus,
  SmartSpectraErrorCode,
  ValidationCode,
  breathingMetrics,
  cardioMetrics,
  faceMetrics,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';

import type {
  AppConfig,
  Mood,
  Question,
  SessionRecord,
  Settings,
  Snapshot,
  ValidationState,
  VivaBridge,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import {
  toSnapshot,
  pulseChip,
  breathingChip,
  faceChip,
  type ChipView,
  type DecodedMetrics,
} from '../shared/signals';
import {
  initialState,
  step,
  drainAnnouncements,
  buildSessionRecord,
  calibrationProgress,
  T,
  type VivaState,
} from '../shared/stateMachine';
import { examinerSvg } from './examiner';
import { renderReport, buildReportPng, fmtClock } from './report';

declare global {
  interface Window {
    viva: VivaBridge;
  }
}

const QUESTIONS_PER_VIVA = 5;

// --- tiny DOM helpers -------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as unknown as T;

function setText(node: HTMLElement | null, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}

function setHtml(node: HTMLElement | null, html: string): void {
  if (node && node.innerHTML !== html) node.innerHTML = html;
}

// --- app state --------------------------------------------------------------

interface Seen {
  pulse: boolean;
  breath: boolean;
  face: boolean;
}

const app = {
  config: null as AppConfig | null,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  viva: initialState(performance.now()),
  sdk: null as SmartSpectraSDK | null,
  stream: null as MediaStream | null,
  screen: 'consent' as 'consent' | 'room' | 'report' | 'settings',
  lastSnap: null as Snapshot | null,
  deck: [] as Question[],
  deckIndex: 0,
  lastQuestion: null as Question | null,
  sessionWallStart: 0,
  dirty: true,
  rafId: 0,
  lastMood: '' as Mood | '',
  reportRecord: null as SessionRecord | null,
  seen: { pulse: false, breath: false, face: false } as Seen,
  running: false,
  tickTimer: 0,
  audio: null as AudioContext | null,
  decodeErrors: 0,
  lastPacer: false,
  lastTickSound: 0,
};

// --- announcements ----------------------------------------------------------

function announce(text: string): void {
  const live = $('live');
  if (!live) return;
  live.textContent = '';
  // A microtask gap makes repeated identical strings announce again.
  window.setTimeout(() => {
    live.textContent = text;
  }, 30);
}

let toastTimer = 0;
function toast(message: string): void {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  requestAnimationFrame(() => node.setAttribute('data-show', 'true'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.setAttribute('data-show', 'false');
    window.setTimeout(() => {
      node.hidden = true;
    }, 260);
  }, 4200);
}

// --- screens ----------------------------------------------------------------

const RAIL_STEPS = ['consent', 'calibrate', 'viva', 'report'] as const;
let lastRail = '';

function syncRail(): void {
  const step: (typeof RAIL_STEPS)[number] | null =
    app.screen === 'settings'
      ? null
      : app.screen === 'consent'
        ? 'consent'
        : app.screen === 'report'
          ? 'report'
          : app.viva.phase === 'calibrating'
            ? 'calibrate'
            : 'viva';

  const key = `${step ?? 'none'}`;
  if (key === lastRail) return;
  lastRail = key;

  const activeIndex = step ? RAIL_STEPS.indexOf(step) : -1;
  document.querySelectorAll<HTMLElement>('.rail__step').forEach((el) => {
    const index = RAIL_STEPS.indexOf(el.dataset['step'] as (typeof RAIL_STEPS)[number]);
    if (index === activeIndex) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
    el.dataset['done'] = String(activeIndex >= 0 && index >= 0 && index < activeIndex);
  });
  $('rail-settings')?.setAttribute('data-active', String(app.screen === 'settings'));
}

function showScreen(name: 'consent' | 'room' | 'report' | 'settings'): void {
  app.screen = name;
  for (const id of ['screen-consent', 'screen-room', 'screen-report', 'screen-settings']) {
    $(id)?.classList.toggle('is-active', id === `screen-${name}`);
  }
  if (name === 'consent') $('api-key')?.focus();
  syncRail();
  app.dirty = true;
}

// --- settings ---------------------------------------------------------------

function applySettings(): void {
  const root = document.documentElement;
  root.setAttribute('data-reduced-motion', String(app.settings.reducedMotion));
  root.setAttribute('data-contrast', String(app.settings.highContrast));

  const t = $('set-telemetry') as HTMLInputElement | null;
  if (t) t.checked = app.settings.telemetry;
  const rm = $('set-reduced-motion') as HTMLInputElement | null;
  if (rm) rm.checked = app.settings.reducedMotion;
  const hc = $('set-contrast') as HTMLInputElement | null;
  if (hc) hc.checked = app.settings.highContrast;
  const snd = $('set-sounds') as HTMLInputElement | null;
  if (snd) snd.checked = app.settings.roomSounds;
  const del = $('set-autodelete') as HTMLSelectElement | null;
  if (del) del.value = String(app.settings.autoDeleteDays);

  const opt = $('opt-telemetry') as HTMLInputElement | null;
  if (opt) opt.checked = app.settings.telemetry;

  setText($('settings-path'), app.config?.dataDir ?? '');
  setText($('consent-version'), app.config ? `v${app.config.appVersion} · SmartSpectra ${app.config.sdkVersion} · ${app.config.platform}` : '');
}

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  app.settings = await window.viva.saveSettings(patch);
  applySettings();
}

// --- deck -------------------------------------------------------------------

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

/** Round-robin across subjects so a viva is never five OS questions in a row. */
function buildDeck(bank: Question[], count: number): Question[] {
  const bySubject = new Map<string, Question[]>();
  for (const q of bank) {
    const list = bySubject.get(q.subject) ?? [];
    list.push(q);
    bySubject.set(q.subject, list);
  }
  const queues = shuffle([...bySubject.values()].map((list) => shuffle(list.slice())));
  const out: Question[] = [];
  while (out.length < count && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      if (out.length >= count) break;
      const next = queue.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

// --- SDK --------------------------------------------------------------------

function wireSdk(sdk: SmartSpectraSDK): void {
  sdk.on('streamAvailable', (stream: MediaStream) => {
    app.stream = stream;
    const video = $('preview') as unknown as HTMLVideoElement;
    if (video) {
      video.srcObject = stream;
      void video.play().catch(() => {});
    }
    const pip = $('pip');
    if (pip) pip.hidden = false;
    setStatus('camera is on · processing on this laptop');
  });

  sdk.on('processingStatus', (status) => {
    if (status === ProcessingStatus.kRunning) {
      setStatus('reading pulse and breathing');
    } else if (status === ProcessingStatus.kStarting) {
      setStatus('waking the camera');
    } else if (status === ProcessingStatus.kStopping) {
      setStatus('stopping the camera');
    } else if (status === ProcessingStatus.kError) {
      setStatus('the SDK hit an error');
    } else if (status === ProcessingStatus.kIdle) {
      setStatus('camera idle');
    }
  });

  sdk.on('validationStatus', (code: number, _ts: number, hint: string) => {
    const validation: ValidationState = { code, hint: hint ?? '', tsMs: performance.now() };
    step(app.viva, { type: 'VALIDATION', validation });
    app.dirty = true;
  });

  sdk.on('metrics', (buf: Uint8Array) => {
    try {
      const decoded = decodeMetrics(buf) as DecodedMetrics;
      const snap = toSnapshot(decoded, performance.now());
      app.lastSnap = snap;
      if (snap.pulse && snap.pulse.stable && snap.pulse.confidence >= 50) app.seen.pulse = true;
      if (snap.breathing && snap.breathing.stable && snap.breathing.confidence >= 50) {
        app.seen.breath = true;
      }
      if (snap.talking != null) app.seen.face = true;
      step(app.viva, { type: 'SNAPSHOT', snap });
      app.dirty = true;
    } catch (err) {
      app.decodeErrors += 1;
      if (app.decodeErrors <= 3) {
        console.error('[viva] failed to decode a metrics packet', err);
      }
    }
  });

  sdk.on('error', (code: number, message: string, retryable: boolean) => {
    void handleSdkError(code, message, retryable);
  });
}

function setStatus(text: string): void {
  const node = $('room-status');
  if (!node) return;
  node.hidden = false;
  setText($('room-status-text'), text);
}

async function handleSdkError(code: number, message: string, retryable: boolean): Promise<void> {
  console.error('[viva] SDK error', code, message, 'retryable=', retryable);

  if (code === SmartSpectraErrorCode.kAuthenticationFailed) {
    toast('Presage rejected the API key. Paste a valid key on the start screen.');
    await stopSdk();
    app.viva = step(app.viva, { type: 'BACK_TO_CONSENT', nowMs: performance.now() });
    showScreen('consent');
    $('api-key')?.focus();
    return;
  }

  if (code === SmartSpectraErrorCode.kCreditExhausted) {
    toast(
      'Presage trial credits are used up. You can still practise with questions only, or replay saved reports.',
    );
    await stopSdk();
    app.viva = step(app.viva, { type: 'BACK_TO_CONSENT', nowMs: performance.now() });
    showScreen('consent');
    return;
  }

  if (code === SmartSpectraErrorCode.kNetworkError && retryable) {
    toast('Network hiccup talking to Presage. Retrying…');
    return;
  }

  toast(`SmartSpectra: ${message}`);
}

async function startSdk(): Promise<void> {
  const key = await window.viva.getApiKey();
  if (!key) throw new Error('no-api-key');

  const sdk = new SmartSpectraSDK({
    apiKey: key,
    requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics],
    // Off unless the user opted in. A new SDK instance per session means a
    // toggle change takes effect on the next viva, exactly as promised.
    enableTelemetry: app.settings.telemetry,
    enableAccumulatedOutput: false,
  });
  wireSdk(sdk);
  app.sdk = sdk;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sdk.start();
      app.running = true;
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: number }).code;
      const retryable = (err as { retryable?: boolean }).retryable;
      if (code === SmartSpectraErrorCode.kNetworkError && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        try {
          await sdk.reset();
        } catch {
          /* rebuild below */
        }
        continue;
      }
      if (retryable && attempt < 2) {
        await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  app.sdk = null;
  try {
    sdk.destroy();
  } catch {
    /* already gone */
  }
  throw lastErr ?? new Error('sdk-start-failed');
}

async function stopSdk(): Promise<void> {
  app.running = false;
  const sdk = app.sdk;
  app.sdk = null;
  if (sdk) {
    try {
      await sdk.stop();
    } catch (err) {
      console.warn('[viva] stop() failed', err);
    }
    try {
      sdk.destroy();
    } catch {
      /* already destroyed */
    }
  }
  app.stream = null;
  const video = $('preview') as unknown as HTMLVideoElement;
  if (video) video.srcObject = null;
  const pip = $('pip');
  if (pip) pip.hidden = true;
  const status = $('room-status');
  if (status) status.hidden = true;
}

// --- session flow -----------------------------------------------------------

async function begin(withSignals: boolean): Promise<void> {
  const keyInput = $('api-key') as unknown as HTMLInputElement;
  const typedKey = keyInput?.value.trim() ?? '';

  if (withSignals) {
    if (typedKey) {
      await window.viva.setApiKey(typedKey);
      app.config = app.config ? { ...app.config, hasApiKey: true } : app.config;
      setText($('api-key-hint'), 'Key saved — encrypted with your OS keychain.');
    }
    const hasKey = typedKey.length > 0 || app.config?.hasApiKey === true;
    if (!hasKey) {
      toast('Paste your Presage API key first — or practise without signals.');
      keyInput?.focus();
      return;
    }
  }

  await patchSettings({
    telemetry: ($('opt-telemetry') as unknown as HTMLInputElement)?.checked ?? false,
  });

  showScreen('room');
  app.seen = { pulse: false, breath: false, face: false };
  app.lastSnap = null;
  app.decodeErrors = 0;
  app.deck = buildDeck(app.config?.questions ?? [], QUESTIONS_PER_VIVA);
  app.deckIndex = 0;
  app.lastQuestion = null;
  app.sessionWallStart = Date.now();
  app.lastMood = '';
  app.lastTickSound = 0;
  app.viva = initialState(performance.now());
  app.viva = step(app.viva, { type: 'CONSENT_GIVEN', nowMs: performance.now() });

  if (!withSignals) {
    app.viva = step(app.viva, { type: 'PRACTICE_MODE', nowMs: performance.now() });
    app.sessionWallStart = Date.now();
    toast('Practice mode — no vitals, no report.');
    app.dirty = true;
    return;
  }

  try {
    await startSdk();
    setStatus('camera is on · processing on this laptop');
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === SmartSpectraErrorCode.kAuthenticationFailed) {
      toast('Presage rejected that API key. Check it and try again.');
      showScreen('consent');
      return;
    }
    if (code === SmartSpectraErrorCode.kCreditExhausted) {
      toast('Presage trial credits are used up. Practising with questions only.');
      app.viva = step(app.viva, { type: 'PRACTICE_MODE', nowMs: performance.now() });
      app.sessionWallStart = Date.now();
      return;
    }
    toast(
      `Could not start the camera (${
        (err as Error).message ?? 'unknown'
      }). You can practise without signals.`,
    );
    showScreen('consent');
    return;
  }
}

function askNext(): void {
  const q = app.deck[app.deckIndex];
  if (!q) {
    void endSession();
    return;
  }
  app.deckIndex += 1;
  app.lastQuestion = q;
  app.viva = step(app.viva, { type: 'NEXT_QUESTION', question: q, nowMs: performance.now() });
  app.dirty = true;
  $('btn-answer-now')?.focus();
}

async function endSession(): Promise<void> {
  const now = performance.now();
  app.viva = step(app.viva, { type: 'END_SESSION', nowMs: now });
  await stopSdk();

  const record = buildSessionRecord(app.viva, {
    startedAt: app.sessionWallStart,
    endedAt: Date.now(),
    telemetryEnabled: app.settings.telemetry,
    appVersion: app.config?.appVersion ?? '1.0.0',
    sdkVersion: app.config?.sdkVersion ?? '3.4.0',
    id: '',
  });

  try {
    const { id } = await window.viva.saveSession(record);
    record.id = id;
  } catch (err) {
    console.error('[viva] could not save the session', err);
    toast('Could not save the session to disk — the report is still here.');
  }

  app.reportRecord = record;
  showScreen('report');
  renderReport(record);
  void refreshHistory();
}

function cancelCalibration(): void {
  void stopSdk();
  app.viva = step(app.viva, { type: 'BACK_TO_CONSENT', nowMs: performance.now() });
  showScreen('consent');
}

// --- rendering --------------------------------------------------------------

function setChip(id: string, view: ChipView): void {
  const node = $(id);
  if (!node) return;
  node.dataset['state'] = view.state;
  setText(node.querySelector('.chip__value') as HTMLElement, view.value);
  setText(node.querySelector('.chip__detail') as HTMLElement, view.detail);
}

const MOOD_LABEL: Record<Mood, string> = {
  neutral: 'external examiner',
  curious: 'examiner is curious',
  encouraging: 'examiner is pleased',
  patient: 'examiner is waiting',
  listening: 'listening…',
};

const VALIDATION_COPY: Record<number, string> = {
  0: 'Framing looks good. Breathe normally.',
  1: 'I can’t see a face yet. Move into the frame.',
  2: 'Only one person at a time, please.',
  3: 'Centre your face in the frame.',
  4: 'Move a little closer to the camera.',
  5: 'It’s too dark here. Add a lamp or face a window.',
  6: 'That’s too bright. Soften the light behind you.',
  7: 'Sit back so your chest is in frame.',
  10: 'The camera is tuning. One moment.',
  11: 'The camera is running slow. Close other apps.',
  12: 'A little too much movement. Settle for a moment.',
  13: 'Move back a little.',
  14: 'Move a little closer.',
  15: 'Lower the camera to face height.',
  16: 'Raise the camera to face height.',
  17: 'Look toward the camera.',
};

function renderCalibration(): void {
  const v = app.viva;
  const overlay = $('calib');
  if (!overlay) return;
  const active = v.phase === 'calibrating' && app.screen === 'room';
  overlay.hidden = !active;
  if (!active) return;

  const p = calibrationProgress(v);
  const ring = $('calib-ring');
  if (ring) ring.style.setProperty('--p', String(Math.max(0, Math.min(1, p.progress))));

  const left = Math.max(0, Math.ceil((T.CALIBRATION_MIN_MS - p.elapsedMs) / 1000));
  setText($('calib-time'), String(left));

  const items = $('calib-signals')?.querySelectorAll('li');
  if (items) {
    const states = [
      p.pulseSamples > 0 ? 'live' : 'waiting',
      p.breathingSamples > 0 ? 'live' : 'waiting',
      p.hrvSamples > 0 ? 'live' : 'waiting',
    ];
    items.forEach((li, i) => {
      const s = states[i] ?? 'waiting';
      if (li.getAttribute('data-state') !== s) li.setAttribute('data-state', s);
    });
  }

  const hint = $('calib-hint');
  if (hint) {
    const code = v.validation?.code;
    const sdkHint = v.validation?.hint?.trim();
    let text = sdkHint && sdkHint.length > 2 ? sdkHint : code != null ? VALIDATION_COPY[code] : undefined;
    if (!text) {
      text = 'Face the camera and keep still. Hints will appear here.';
    }
    if (p.elapsedMs > T.CALIBRATION_EXTEND_MS && !p.ready) {
      text = `Still waiting on a clean pulse reading. ${text}`;
    }
    setText(hint, text);
  }

  const skip = $('btn-calib-skip');
  if (skip) skip.hidden = !p.timedOut;
}

function renderQuestion(): void {
  const v = app.viva;
  const q = v.current?.question ?? app.lastQuestion;

  const card = $('qcard');
  const subject = $('q-subject');
  const topic = $('q-topic');
  const text = $('q-question');
  const stamp = $('q-stamp');
  const phase = $('q-phase');

  const live = v.phase === 'think' || v.phase === 'answer' || v.phase === 'between';

  if (!q || !live) {
    card?.classList.add('is-empty');
    setText(subject, 'Viva Mode');
    setText(topic, 'Lab 3 · external examiner');
    setText(
      text,
      v.phase === 'ready'
        ? 'Press “Ask me a question” when you’re ready. There is no timer on you.'
        : 'Waiting for the examiner…',
    );
    setText(stamp, `Q. ${v.asked}/${QUESTIONS_PER_VIVA}`);
    setText(phase, v.phase === 'ready' ? 'Ready when you are' : 'Not started');
    setText($('q-timer'), '00:00');
    setText($('q-followup'), '');
    $('q-followup')?.setAttribute('hidden', '');
    return;
  }

  card?.classList.remove('is-empty');
  setText(subject, `${q.subject}${q.subjectCode ? ` · ${q.subjectCode}` : ''}`);
  setText(topic, `${q.module} · ${q.topic}`);
  setText(text, q.question);
  setText(stamp, `Q. ${Math.max(1, v.asked)}/${QUESTIONS_PER_VIVA}`);

  const elapsed =
    v.phase === 'think'
      ? v.nowMs - v.phaseStartMs
      : v.phase === 'answer'
        ? v.nowMs - (v.current?.askMs ?? v.phaseStartMs)
        : (v.nowMs - (v.current?.askMs ?? v.phaseStartMs));

  const labels: Record<string, string> = {
    think: 'Think it through',
    answer: 'Answer out loud',
    between: 'Answer recorded',
  };
  setText(phase, labels[v.phase] ?? '');
  setText($('q-timer'), fmtClock(elapsed));

  const follow = $('q-followup');
  if (follow) {
    const showFollow =
      v.phase === 'between' &&
      v.results.length > 0 &&
      v.results[v.results.length - 1]?.settled === true &&
      q.followUp.length > 0;
    if (showFollow) {
      follow.textContent = `Follow-up: ${q.followUp}`;
      follow.hidden = false;
    } else {
      follow.hidden = true;
    }
  }
}

function renderControls(): void {
  const v = app.viva;
  const show = (id: string, on: boolean) => {
    const node = $(id);
    if (node) node.hidden = !on;
  };

  show('btn-ask', v.phase === 'ready');
  show('btn-answer-now', v.phase === 'think');
  show('btn-done-answering', v.phase === 'answer');

  const lastQuestion = v.results.length >= QUESTIONS_PER_VIVA;
  const next = $('btn-next');
  if (next) {
    next.hidden = v.phase !== 'between';
    next.textContent = lastQuestion ? 'See my Calm Report' : 'Next question';
  }

  const end = $('btn-end');
  if (end) end.hidden = false;
}

function renderHint(): void {
  const v = app.viva;
  const hint = $('hud-hint');
  if (!hint) return;

  if (v.practiceOnly) {
    setText(hint, 'Practice mode: questions only. No vitals are read and no report is saved.');
    return;
  }
  if (v.phase === 'calibrating') {
    setText(hint, 'Learning your baseline. Hold still and breathe normally.');
    return;
  }
  if (v.phase === 'ready') {
    setText(hint, 'The examiner is ready. Ask for a question when you are.');
    return;
  }
  if (v.phase === 'think') {
    if (v.pacer) {
      setText(hint, 'Breathing is above your baseline. Follow the orb: in for 4, out for 6.');
    } else if (v.drive === 'none') {
      setText(hint, 'Breathing is unreadable right now, so the room is holding still. Take your time.');
    } else {
      setText(hint, 'Take your time. The room follows your breathing, not the clock.');
    }
    return;
  }
  if (v.phase === 'answer') {
    setText(hint, 'Answer out loud. Breathing pauses while you talk; your pulse keeps running.');
    return;
  }
  if (v.phase === 'between') {
    setText(hint, 'Answer recorded. Next question whenever you are ready.');
  }
}

function render(): void {
  const v = app.viva;
  const root = document.documentElement;
  root.style.setProperty('--calm', v.calm.toFixed(3));

  // examiner
  const examiner = $('examiner');
  if (examiner && v.mood !== app.lastMood) {
    examiner.innerHTML = examinerSvg(v.mood);
    examiner.dataset['mood'] = v.mood;
    app.lastMood = v.mood;
  }
  setText($('room-mood'), MOOD_LABEL[v.mood]);

  // pacer
  const pacer = $('pacer');
  if (pacer) pacer.dataset['visible'] = v.pacer ? 'true' : 'false';
  if (v.pacer !== app.lastPacer) {
    app.lastPacer = v.pacer;
    if (v.pacer && app.settings.roomSounds) chime();
  }

  // chips
  const calib = calibrationProgress(v);
  const warming = v.phase === 'calibrating';
  const validationOk = v.validation?.code === ValidationCode.kOk;

  if (v.practiceOnly) {
    for (const id of ['chip-pulse', 'chip-breath', 'chip-face']) {
      setChip(id, { state: 'off', label: '', value: '—', detail: 'off in practice mode' });
    }
  } else {
    setChip(
      'chip-pulse',
      pulseChip(app.lastSnap?.pulse ?? null, v.pulseEma, {
        warming: warming && !app.seen.pulse,
        validationOk,
      }),
    );
    setChip(
      'chip-breath',
      breathingChip(app.lastSnap?.breathing ?? null, v.breathEma, {
        warming: warming && !app.seen.breath,
        talking: v.talking === true,
        validationOk,
      }),
    );
    setChip(
      'chip-face',
      faceChip({
        validationOk,
        hasFace: v.validation?.code !== ValidationCode.kNoFaceFound,
        warming: warming && !app.seen.face,
      }),
    );
  }

  // baseline strip
  const strip = $('baseline-strip');
  if (strip) {
    const b = v.baseline;
    strip.hidden = !b;
    if (b) {
      const bits: string[] = [];
      if (b.pulse != null) bits.push(`pulse ${Math.round(b.pulse)} bpm`);
      if (b.breathing != null) bits.push(`breathing ${b.breathing.toFixed(1)}/min`);
      if (b.rmssd != null) bits.push('HRV captured');
      setText($('baseline-values'), bits.join(' · ') || 'no usable signals');
    }
  }

  renderQuestion();
  renderControls();
  renderHint();
  renderCalibration();

  const msgs = drainAnnouncements(v);
  if (msgs.length) announce(msgs.join(' '));

  syncRail();
  app.dirty = false;
}

function loop(): void {
  if (app.dirty) render();
  app.rafId = requestAnimationFrame(loop);
}

// --- audio ------------------------------------------------------------------

function audioCtx(): AudioContext | null {
  if (app.audio) return app.audio;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    app.audio = new Ctor();
    return app.audio;
  } catch {
    return null;
  }
}

/** A soft, short click whose volume follows how tense the room is. */
function tickSound(calm: number): void {
  const ctx = audioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 1400;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.02 * (1 - calm) + 0.001, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.06);
}

function chime(): void {
  const ctx = audioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [i, freq] of [523.25, 659.25].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.05, now + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.7);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.12);
    osc.stop(now + i * 0.12 + 0.8);
  }
}

// --- history ----------------------------------------------------------------

async function refreshHistory(): Promise<void> {
  const list = $('history-list');
  if (!list) return;
  const sessions = await window.viva.listSessions();
  if (sessions.length === 0) {
    list.innerHTML = '<p class="history__empty">No saved vivas yet.</p>';
    return;
  }
  list.innerHTML = sessions
    .map((s) => {
      const when = new Date(s.startedAt).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `<div class="history__row">
        <span>${when} · ${s.questionCount} question${s.questionCount === 1 ? '' : 's'}${
          s.practiceOnly ? ' · practice' : ''
        }${s.calmestTopic ? ` · calmest: ${s.calmestTopic}` : ''}</span>
        <span>
          <button class="btn btn--ghost" data-open="${s.id}" type="button">Open</button>
          <button class="btn btn--ghost" data-del="${s.id}" type="button">Delete</button>
        </span>
      </div>`;
    })
    .join('');

  list.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['open'];
      if (!id) return;
      const rec = await window.viva.getSession(id);
      if (!rec) {
        toast('That session file is gone.');
        return;
      }
      app.reportRecord = rec;
      showScreen('report');
      renderReport(rec);
    });
  });
  list.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['del'];
      if (!id) return;
      await window.viva.deleteSession(id);
      toast('Session deleted from this laptop.');
      void refreshHistory();
    });
  });
}

// --- wiring -----------------------------------------------------------------

function wire(): void {
  $('btn-begin')?.addEventListener('click', () => void begin(true));
  $('btn-practice')?.addEventListener('click', () => void begin(false));

  $('btn-ask')?.addEventListener('click', askNext);
  $('btn-next')?.addEventListener('click', () => {
    if (app.viva.results.length >= QUESTIONS_PER_VIVA) void endSession();
    else askNext();
  });
  $('btn-answer-now')?.addEventListener('click', () => {
    app.viva = step(app.viva, { type: 'START_ANSWER', nowMs: performance.now() });
    app.dirty = true;
  });
  $('btn-done-answering')?.addEventListener('click', () => {
    app.viva = step(app.viva, { type: 'FINISH_ANSWER', nowMs: performance.now() });
    app.dirty = true;
  });
  $('btn-end')?.addEventListener('click', () => void endSession());

  const openSettings = () => {
    applySettings();
    showScreen('settings');
  };
  $('btn-settings')?.addEventListener('click', openSettings);
  $('rail-settings')?.addEventListener('click', openSettings);
  $('btn-settings-close')?.addEventListener('click', () => {
    showScreen(app.viva.phase === 'report' ? 'report' : 'room');
  });

  $('btn-calib-cancel')?.addEventListener('click', cancelCalibration);
  $('btn-calib-skip')?.addEventListener('click', () => {
    void stopSdk();
    app.viva = step(app.viva, { type: 'PRACTICE_MODE', nowMs: performance.now() });
    app.sessionWallStart = Date.now();
    app.dirty = true;
  });

  $('btn-report-again')?.addEventListener('click', () => {
    app.viva = step(app.viva, { type: 'BACK_TO_CONSENT', nowMs: performance.now() });
    showScreen('consent');
  });

  $('btn-export')?.addEventListener('click', async () => {
    const rec = app.reportRecord;
    if (!rec) return;
    const dataUrl = buildReportPng(rec);
    if (!dataUrl) {
      toast('Could not draw the report image.');
      return;
    }
    const name = `viva-mode-calm-report-${new Date(rec.startedAt)
      .toISOString()
      .slice(0, 10)}.png`;
    const res = await window.viva.savePng(dataUrl, name);
    if (res.ok) toast(`Saved to ${res.path ?? 'your chosen folder'}`);
  });

  const bindToggle = (id: string, key: keyof Settings) => {
    $(id)?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      void patchSettings({ [key]: target.checked } as Partial<Settings>);
    });
  };
  bindToggle('set-telemetry', 'telemetry');
  bindToggle('set-reduced-motion', 'reducedMotion');
  bindToggle('set-contrast', 'highContrast');
  bindToggle('set-sounds', 'roomSounds');

  $('set-autodelete')?.addEventListener('change', (e) => {
    const value = Number((e.target as HTMLSelectElement).value) || 0;
    void patchSettings({ autoDeleteDays: value });
  });

  $('btn-open-folder')?.addEventListener('click', () => void window.viva.openDataFolder());

  $('btn-delete-all')?.addEventListener('click', async () => {
    const ok = window.confirm(
      'Delete every viva, every report and the saved API key from this laptop? This cannot be undone.',
    );
    if (!ok) return;
    await window.viva.deleteAllData();
    app.config = app.config ? { ...app.config, hasApiKey: false } : app.config;
    app.settings = { ...DEFAULT_SETTINGS };
    applySettings();
    await refreshHistory();
    toast('All Viva Mode data deleted from this laptop.');
  });

  $('btn-save-key')?.addEventListener('click', async () => {
    const input = $('set-api-key') as unknown as HTMLInputElement;
    const value = input?.value.trim() ?? '';
    if (!value) {
      toast('Paste a key first.');
      return;
    }
    await window.viva.setApiKey(value);
    app.config = app.config ? { ...app.config, hasApiKey: true } : app.config;
    input.value = '';
    setText($('set-api-key-hint'), 'Key saved — encrypted with your OS keychain.');
    toast('API key saved.');
  });

  $('btn-recalibrate')?.addEventListener('click', () => {
    showScreen('room');
    app.viva = step(app.viva, { type: 'RECALIBRATE', nowMs: performance.now() });
    app.lastSnap = null;
    app.seen = { pulse: false, breath: false, face: false };
    app.sessionWallStart = Date.now();
    app.dirty = true;
    void startSdk().catch((err) => {
      toast(`Could not restart the camera: ${(err as Error).message}`);
      showScreen('consent');
    });
  });

  // Keyboard: space on the primary action, Esc to end.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12') {
      return; // devtools handled by the main process in --dev
    }
    if (e.key === 'Escape' && app.screen === 'settings') {
      showScreen(app.viva.phase === 'report' ? 'report' : 'room');
    }
  });

  window.addEventListener('beforeunload', () => {
    if (app.sdk) {
      try {
        app.sdk.destroy();
      } catch {
        /* nothing to do */
      }
    }
  });
}

// --- boot -------------------------------------------------------------------

function startTick(): void {
  window.clearInterval(app.tickTimer);
  app.tickTimer = window.setInterval(() => {
    const v = app.viva;
    const live =
      v.phase === 'calibrating' ||
      v.phase === 'think' ||
      v.phase === 'answer' ||
      v.phase === 'between';
    if (!live) return;
    app.viva = step(v, { type: 'TICK', nowMs: performance.now() });
    app.dirty = true;

    if (app.settings.roomSounds && v.phase === 'think') {
      const now = performance.now();
      if (now - app.lastTickSound >= 1000) {
        app.lastTickSound = now;
        tickSound(v.calm);
      }
    }
  }, 250);
}

async function boot(): Promise<void> {
  try {
    app.config = await window.viva.getConfig();
  } catch (err) {
    console.error('[viva] getConfig failed', err);
  }
  app.settings = app.config?.settings ?? { ...DEFAULT_SETTINGS };

  applySettings();
  wire();
  startTick();
  showScreen('consent');

  const version = $('consent-version');
  if (version && app.config) {
    version.textContent = `v${app.config.appVersion} · SmartSpectra ${app.config.sdkVersion} · ${app.config.platform}`;
  }
  const hint = $('api-key-hint');
  if (hint && app.config?.hasApiKey) {
    hint.textContent =
      app.config.apiKeySource === 'env'
        ? 'Using the key from PRESAGE_API_KEY.'
        : 'A key is already saved, encrypted with your OS keychain.';
  }

  // The examiner is drawn before the camera ever turns on.
  const examiner = $('examiner');
  if (examiner) {
    examiner.innerHTML = examinerSvg('neutral');
    examiner.dataset['mood'] = 'neutral';
  }
  const preview = $('consent-preview');
  if (preview) preview.innerHTML = examinerSvg('neutral');

  app.rafId = requestAnimationFrame(loop);
}

void boot();
