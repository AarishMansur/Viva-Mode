
import {
  deltaPct,
  ema,
  EXPRESSION_LABELS,
  median,
  breathingUsable,
  pulseUsable,
} from './signals.ts';
import type {
  Baseline,
  HrvSample,
  Mood,
  Phase,
  Question,
  QuestionResult,
  SessionRecord,
  Snapshot,
  TimelinePoint,
  ValidationState,
} from './types.ts';


export const T = {
  CALIBRATION_MIN_MS: 60_000,
  CALIBRATION_MAX_MS: 120_000,
  CALIBRATION_MIN_PULSE_SAMPLES: 20,
  CALIBRATION_EXTEND_MS: 75_000,

  BREATH_TAU_S: 10,
  PULSE_TAU_S: 6,

  BREATH_ELEVATED: 0.15,
  BREATH_SETTLED: 0.05,
  PULSE_ELEVATED: 0.1,
  PULSE_SETTLED: 0.03,

  SETTLED_HOLD_MS: 8_000,
  PACER_COOLDOWN_MS: 20_000,
  MOOD_COOLDOWN_MS: 6_000,

  CALM_RATE_PER_S: 0.08,
  CALM_MAX_STEP: 0.08,
  ROOM_NEUTRAL: 0.5,

  TALKING_ONSET_MS: 1_200,
  ANSWER_SILENCE_MS: 4_000,
  ANSWER_MAX_MS: 240_000,

  FRESH_MS: 20_000,
  TIMELINE_MS: 1_000,
  ROOM_TICK_MS: 500,

  SPIKE_PCT: 10,
} as const;


export interface CalibrationState {
  startMs: number;
  pulse: number[];
  breathing: number[];
  hrv: HrvSample[];
  doneMs: number | null;
}

export interface CurrentQuestion {
  question: Question;
  askMs: number;
  firstWordMs: number | null;
  pulseMax: number | null;
  breathSum: number;
  breathCount: number;
  pacerShown: boolean;
  pacerShownAt: number | null;
  settledAt: number | null;
  expressionHint: string | null;
}

export interface VivaState {
  phase: Phase;
  nowMs: number;
  sessionStartMs: number;
  phaseStartMs: number;

  baseline: Baseline | null;
  calibration: CalibrationState;
  calibrationTimedOut: boolean;
  practiceOnly: boolean;

  breathEma: number | null;
  breathEmaAt: number | null;
  pulseEma: number | null;
  pulseEmaAt: number | null;
  breathSeenAt: number | null;
  pulseSeenAt: number | null;

  lastPulseTs: number | null;
  lastBreathTs: number | null;

  talking: boolean | null;
  talkingSince: number | null;
  silenceSince: number | null;

  calm: number;
  pacer: boolean;
  pacerCooldownUntil: number;
  calmHeldSince: number | null;
  mood: Mood;
  moodUntil: number;
  drive: 'breathing' | 'pulse' | 'none';

  current: CurrentQuestion | null;
  results: QuestionResult[];
  timeline: TimelinePoint[];
  hrvSession: HrvSample[];

  lastRoomAt: number;
  lastTimelineAt: number;

  validation: ValidationState | null;
  announcements: string[];

  asked: number;
}

export type VivaEvent =
  | { type: 'CONSENT_GIVEN'; nowMs: number }
  | { type: 'SNAPSHOT'; snap: Snapshot }
  | { type: 'VALIDATION'; validation: ValidationState }
  | { type: 'TICK'; nowMs: number }
  | { type: 'NEXT_QUESTION'; question: Question; nowMs: number }
  | { type: 'START_ANSWER'; nowMs: number }
  | { type: 'FINISH_ANSWER'; nowMs: number }
  | { type: 'END_SESSION'; nowMs: number }
  | { type: 'PRACTICE_MODE'; nowMs: number }
  | { type: 'RECALIBRATE'; nowMs: number }
  | { type: 'BACK_TO_CONSENT'; nowMs: number };

export function initialState(nowMs: number): VivaState {
  return {
    phase: 'consent',
    nowMs,
    sessionStartMs: nowMs,
    phaseStartMs: nowMs,
    baseline: null,
    calibration: { startMs: nowMs, pulse: [], breathing: [], hrv: [], doneMs: null },
    calibrationTimedOut: false,
    practiceOnly: false,
    breathEma: null,
    breathEmaAt: null,
    pulseEma: null,
    pulseEmaAt: null,
    breathSeenAt: null,
    pulseSeenAt: null,
    lastPulseTs: null,
    lastBreathTs: null,
    talking: null,
    talkingSince: null,
    silenceSince: null,
    calm: 0,
    pacer: false,
    pacerCooldownUntil: 0,
    calmHeldSince: null,
    mood: 'neutral',
    moodUntil: 0,
    drive: 'none',
    current: null,
    results: [],
    timeline: [],
    hrvSession: [],
    lastRoomAt: nowMs,
    lastTimelineAt: nowMs,
    validation: null,
    announcements: [],
    asked: 0,
  };
}


function say(s: VivaState, line: string): void {
  s.announcements.push(line);
  if (s.announcements.length > 12) s.announcements.shift();
}


export function drainAnnouncements(s: VivaState): string[] {
  if (s.announcements.length === 0) return [];
  const out = s.announcements.slice();
  s.announcements.length = 0;
  return out;
}

function stepToward(current: number, target: number, maxStep: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

function setMood(s: VivaState, mood: Mood, now: number, force = false): void {
  if (s.mood === mood) return;
  if (!force && now < s.moodUntil) return;
  s.mood = mood;
  s.moodUntil = now + T.MOOD_COOLDOWN_MS;
}


function breathFresh(s: VivaState, now: number): boolean {
  return (
    s.breathEma != null &&
    s.breathSeenAt != null &&
    now - s.breathSeenAt < T.FRESH_MS &&
    s.talking !== true
  );
}

function pulseFresh(s: VivaState, now: number): boolean {
  return s.pulseEma != null && s.pulseSeenAt != null && now - s.pulseSeenAt < T.FRESH_MS;
}


export function pickDrive(s: VivaState, now: number): 'breathing' | 'pulse' | 'none' {
          if (s.baseline?.breathing != null) {
    return breathFresh(s, now) ? 'breathing' : 'none';
  }
  if (pulseFresh(s, now) && s.baseline?.pulse != null) return 'pulse';
  return 'none';
}


function ingest(s: VivaState, snap: Snapshot, now: number): void {
      if (snap.talking != null) {
    if (snap.talking) {
      if (s.talkingSince == null) s.talkingSince = now;
      s.silenceSince = null;
    } else {
      s.talkingSince = null;
      if (s.silenceSince == null) s.silenceSince = now;
    }
    s.talking = snap.talking;
  }

        if (snap.pulse && (s.lastPulseTs == null || snap.pulse.tsMs > s.lastPulseTs)) {
    s.lastPulseTs = snap.pulse.tsMs;
    if (pulseUsable(snap.pulse)) {
      const dt = s.pulseEmaAt == null ? 0 : (snap.pulse.tsMs - s.pulseEmaAt) / 1000;
      s.pulseEma = ema(s.pulseEma, snap.pulse.value, dt, T.PULSE_TAU_S);
      s.pulseEmaAt = snap.pulse.tsMs;
      s.pulseSeenAt = now;
      if (s.phase === 'calibrating') s.calibration.pulse.push(snap.pulse.value);
    }
  }

      if (snap.breathing && (s.lastBreathTs == null || snap.breathing.tsMs > s.lastBreathTs)) {
    s.lastBreathTs = snap.breathing.tsMs;
    if (breathingUsable(snap.breathing) && s.talking !== true) {
      const dt = s.breathEmaAt == null ? 0 : (snap.breathing.tsMs - s.breathEmaAt) / 1000;
      s.breathEma = ema(s.breathEma, snap.breathing.value, dt, T.BREATH_TAU_S);
      s.breathEmaAt = snap.breathing.tsMs;
      s.breathSeenAt = now;
      if (s.phase === 'calibrating') s.calibration.breathing.push(snap.breathing.value);
    }
  }

      if (snap.hrv && snap.hrv.stable && snap.hrv.confidence >= 50) {
    if (s.phase === 'calibrating') s.calibration.hrv.push(snap.hrv);
    if (s.hrvSession.length < 600) s.hrvSession.push(snap.hrv);
  }

    if (s.current && snap.expression && snap.expression.confidence >= 60) {
    const label = EXPRESSION_LABELS[snap.expression.type];
    if (label && label !== 'neutral') s.current.expressionHint = label;
  }
}


function completeCalibration(s: VivaState, now: number): void {
  const pulse = median(s.calibration.pulse);
  const breathing = median(s.calibration.breathing);
  const rmssd = median(s.calibration.hrv.map((h) => h.rmssd));
  const baevsky = median(s.calibration.hrv.map((h) => h.baevsky));

  s.baseline = {
    pulse,
    breathing,
    rmssd,
    baevsky,
    pulseSamples: s.calibration.pulse.length,
    breathingSamples: s.calibration.breathing.length,
    hrvSamples: s.calibration.hrv.length,
    capturedAt: now,
  };
  s.calibration.doneMs = now;
  s.phase = 'ready';
  s.phaseStartMs = now;
  s.calm = 0;
  s.mood = 'neutral';
  s.moodUntil = now + T.MOOD_COOLDOWN_MS;

  const bits: string[] = [];
  if (pulse != null) bits.push(`pulse ${Math.round(pulse)}`);
  if (breathing != null) bits.push(`breathing ${breathing.toFixed(1)} a minute`);
  say(
    s,
    bits.length
      ? `Baseline captured: ${bits.join(', ')}. Ready when you are.`
      : 'Baseline captured. Ready when you are.',
  );
}

/** Whether calibration has met both of its gates. */
export function calibrationProgress(s: VivaState): {
  elapsedMs: number;
  pulseSamples: number;
  breathingSamples: number;
  hrvSamples: number;
  ready: boolean;
  timedOut: boolean;
  progress: number;
} {
  const elapsedMs = s.nowMs - s.calibration.startMs;
  const timeGate = Math.min(1, elapsedMs / T.CALIBRATION_MIN_MS);
  const pulseGate = Math.min(1, s.calibration.pulse.length / T.CALIBRATION_MIN_PULSE_SAMPLES);
  return {
    elapsedMs,
    pulseSamples: s.calibration.pulse.length,
    breathingSamples: s.calibration.breathing.length,
    hrvSamples: s.calibration.hrv.length,
    ready: timeGate >= 1 && pulseGate >= 1,
    timedOut: elapsedMs >= T.CALIBRATION_MAX_MS,
    progress: Math.min(timeGate, pulseGate),
  };
}

// --- room -------------------------------------------------------------------

/**
 * One adaptive-room tick. Called at most every ROOM_TICK_MS.
 *
 * Hysteresis: elevated is > +15 %, settled is ≤ +5 %. The 5–15 % band is
 * deliberately inert, which is what stops the pacer and the room from
 * flapping on a noisy 30 s breathing average.
 */
function updateRoom(s: VivaState, now: number): void {
  const dt = Math.min((now - s.lastRoomAt) / 1000, 2);
  s.lastRoomAt = now;

  if (s.phase !== 'think' || s.practiceOnly) {
    // Outside the think phase the room holds still. The answer phase freezes
    // by design: breathing is invalid while you talk.
    s.pacer = false;
    s.drive = 'none';
    return;
  }

  const c = s.current;
  if (c) {
    if (s.pulseEma != null) {
      c.pulseMax = c.pulseMax == null ? s.pulseEma : Math.max(c.pulseMax, s.pulseEma);
    }
    if (breathFresh(s, now) && s.breathEma != null) {
      c.breathSum += s.breathEma;
      c.breathCount += 1;
    }
  }

  const drive = pickDrive(s, now);
  s.drive = drive;

  if (drive === 'none') {
    // Missing data never punishes: the room eases back toward neutral.
    s.pacer = false;
    s.calmHeldSince = null;
    s.calm = stepToward(s.calm, T.ROOM_NEUTRAL, T.CALM_MAX_STEP);
    return;
  }

  const isBreath = drive === 'breathing';
  const value = isBreath ? s.breathEma : s.pulseEma;
  const base = isBreath ? s.baseline?.breathing : s.baseline?.pulse;
  if (value == null || base == null || base === 0) return;

  const delta = (value - base) / base;
  const elevated = isBreath ? T.BREATH_ELEVATED : T.PULSE_ELEVATED;
  const settled = isBreath ? T.BREATH_SETTLED : T.PULSE_SETTLED;
  const stepSize = Math.min(T.CALM_MAX_STEP, T.CALM_RATE_PER_S * Math.max(dt, 0.25));

  if (delta > elevated) {
    s.calmHeldSince = null;
    if (!s.pacer && now >= s.pacerCooldownUntil) {
      s.pacer = true;
      if (s.current) {
        s.current.pacerShown = true;
        if (s.current.pacerShownAt == null) s.current.pacerShownAt = now;
      }
      // The pacer appearing is a discrete event: show it in the examiner's
      // face immediately, even if the mood cooldown is still running.
      setMood(s, 'patient', now, true);
      say(s, 'Breathing is above your baseline. The pacer appeared — follow the orb.');
    }
    s.calm = Math.max(0, s.calm - stepSize);
    setMood(s, 'patient', now);
    return;
  }

  if (delta <= settled) {
    if (s.calmHeldSince == null) {
      s.calmHeldSince = now;
      return;
    }
    if (now - s.calmHeldSince < T.SETTLED_HOLD_MS) return;

    if (s.calm < 0.999) {
      const before = s.calm;
      s.calm = Math.min(1, s.calm + stepSize);
      if (Math.floor(before * 5) !== Math.floor(s.calm * 5)) {
        say(s, `The room calmed a step. ${roomDescription(s.calm)}`);
      }
    }
    if (s.pacer) {
      s.pacer = false;
      s.pacerCooldownUntil = now + T.PACER_COOLDOWN_MS;
      say(s, 'You settled back toward your baseline. The pacer stepped aside.');
    }
    if (s.current && s.current.settledAt == null) {
      s.current.settledAt = now;
      if (s.current.pacerShown) say(s, 'Recovered — breathing is back within your baseline band.');
    }
    setMood(s, 'encouraging', now);
    return;
  }

  // The 5–15 % hysteresis band: hold, and stay quiet.
  s.calmHeldSince = null;
  if (s.mood === 'patient' && delta <= elevated) setMood(s, 'curious', now);
}

/** Human-readable description of the room at a given calm level. */
export function roomDescription(calm: number): string {
  if (calm >= 0.75) return 'The desk lamp is warm and the desk is clear.';
  if (calm >= 0.5) return 'The tube light has stopped flickering.';
  if (calm >= 0.25) return 'The clutter on the desk is thinning out.';
  return 'The tube light is flickering and the fan is wobbling.';
}

// --- questions --------------------------------------------------------------

function finaliseQuestion(s: VivaState, now: number): QuestionResult | null {
  const c = s.current;
  if (!c) return null;

  const basePulse = s.baseline?.pulse ?? null;
  const pulseMax = c.pulseMax;
  const answerEnd = now;
  const firstWord = c.firstWordMs;

  const result: QuestionResult = {
    questionId: c.question.id,
    topic: c.question.topic,
    subject: c.question.subject,
    module: c.question.module,
    question: c.question.question,
    askedAt: c.askMs,
    answerLatencyMs: firstWord != null ? Math.max(0, firstWord - c.askMs) : null,
    answerMs: firstWord != null ? Math.max(0, answerEnd - firstWord) : 0,
    pulseMax,
    pulseDeltaPct: pulseMax != null ? deltaPct(pulseMax, basePulse) : null,
    breathingThinkAvg: c.breathCount > 0 ? c.breathSum / c.breathCount : null,
    settled: c.settledAt != null,
    recoveryMs:
      c.pacerShownAt != null && c.settledAt != null
        ? Math.max(0, c.settledAt - c.pacerShownAt)
        : null,
    pacerShown: c.pacerShown,
    expressionHint: c.expressionHint,
  };

  s.results.push(result);
  s.current = null;
  return result;
}

// --- evaluation -------------------------------------------------------------

function evaluate(s: VivaState, now: number): void {
  s.nowMs = now;

  // 1. Calibration gates.
  if (s.phase === 'calibrating') {
    const p = calibrationProgress(s);
    if (p.timedOut) s.calibrationTimedOut = true;
    if (p.ready) {
      completeCalibration(s, now);
    }
  }

  // 2. Think → Answer: 1.2 s of continuous talking.
  if (s.phase === 'think' && s.talkingSince != null && now - s.talkingSince >= T.TALKING_ONSET_MS) {
    enterAnswer(s, now, s.talkingSince);
  }

  // 3. Answer → Between: 4 s of silence, or the hard cap.
  if (s.phase === 'answer') {
    const silentFor = s.silenceSince != null ? now - s.silenceSince : 0;
    const answerFor = s.phaseStartMs ? now - s.phaseStartMs : 0;
    if (silentFor >= T.ANSWER_SILENCE_MS || answerFor >= T.ANSWER_MAX_MS) {
      enterBetween(s, now);
    }
  }

  // 4. Room, at a fixed cadence.
  if (now - s.lastRoomAt >= T.ROOM_TICK_MS) updateRoom(s, now);

  // 5. Timeline, at 1 Hz while the viva is live.
  const live = s.phase === 'think' || s.phase === 'answer' || s.phase === 'between';
  if (live && now - s.lastTimelineAt >= T.TIMELINE_MS) {
    s.lastTimelineAt = now;
    s.timeline.push({
      t: now - s.sessionStartMs,
      pulse: s.pulseEma != null ? Math.round(s.pulseEma * 10) / 10 : null,
      breathing:
        s.talking === true || s.breathEma == null
          ? null
          : Math.round(s.breathEma * 10) / 10,
      q: s.current ? s.results.length : null,
      phase: s.phase,
    });
  }
}

export function enterAnswer(s: VivaState, now: number, startedAt: number): void {
  if (s.phase === 'think') {
    s.phase = 'answer';
    s.phaseStartMs = now;
    s.silenceSince = null;
    if (s.current && s.current.firstWordMs == null) s.current.firstWordMs = startedAt;
    setMood(s, 'listening', now, true);
    say(s, 'Answer phase. Breathing is paused while you talk; your pulse is still running.');
  }
}

export function enterBetween(s: VivaState, now: number): void {
  if (s.phase !== 'answer') return;
  finaliseQuestion(s, now);
  s.phase = 'between';
  s.phaseStartMs = now;
  s.pacer = false;
  s.talkingSince = null;
  s.silenceSince = null;
  setMood(s, 'neutral', now, true);
  say(s, 'Answer recorded. Next question when you are ready.');
}

// --- the reducer ------------------------------------------------------------

export function step(s: VivaState, ev: VivaEvent): VivaState {
  switch (ev.type) {
    case 'CONSENT_GIVEN': {
      s.phase = 'calibrating';
      s.sessionStartMs = ev.nowMs;
      s.phaseStartMs = ev.nowMs;
      s.nowMs = ev.nowMs;
      s.calibration = { startMs: ev.nowMs, pulse: [], breathing: [], hrv: [], doneMs: null };
      s.calibrationTimedOut = false;
      s.practiceOnly = false;
      s.baseline = null;
      s.breathEma = null;
      s.breathEmaAt = null;
      s.pulseEma = null;
      s.pulseEmaAt = null;
      s.breathSeenAt = null;
      s.pulseSeenAt = null;
      s.lastPulseTs = null;
      s.lastBreathTs = null;
      s.talking = null;
      s.talkingSince = null;
      s.silenceSince = null;
      s.calm = 0;
      s.pacer = false;
      s.calmHeldSince = null;
      s.mood = 'neutral';
      s.moodUntil = ev.nowMs;
      s.drive = 'none';
      s.current = null;
      s.results = [];
      s.timeline = [];
      s.hrvSession = [];
      s.lastRoomAt = ev.nowMs;
      s.lastTimelineAt = ev.nowMs;
      s.asked = 0;
      say(s, 'Calibration started. Sit like you are waiting outside the lab.');
      return s;
    }

    case 'PRACTICE_MODE': {
      s.phase = 'ready';
      s.practiceOnly = true;
      s.sessionStartMs = ev.nowMs;
      s.phaseStartMs = ev.nowMs;
      s.nowMs = ev.nowMs;
      s.baseline = null;
      s.current = null;
      s.results = [];
      s.timeline = [];
      s.hrvSession = [];
      s.calm = 0;
      say(s, 'Practice mode. Questions only, no vitals, no report.');
      return s;
    }

    case 'SNAPSHOT': {
      const now = ev.snap.tsMs || s.nowMs;
      ingest(s, ev.snap, now);
      evaluate(s, now);
      return s;
    }

    case 'VALIDATION': {
      s.validation = ev.validation;
      return s;
    }

    case 'TICK': {
      evaluate(s, ev.nowMs);
      return s;
    }

    case 'NEXT_QUESTION': {
      if (s.phase !== 'ready' && s.phase !== 'between') return s;
      s.asked += 1;
      s.phase = 'think';
      s.phaseStartMs = ev.nowMs;
      s.nowMs = ev.nowMs;
      // Each question gets its own arc, so the room visibly responds again.
      s.calm = 0;
      s.pacer = false;
      s.calmHeldSince = null;
      s.pacerCooldownUntil = 0;
      s.talkingSince = null;
      s.silenceSince = null;
      s.lastRoomAt = ev.nowMs;
      s.lastTimelineAt = ev.nowMs;
      s.current = {
        question: ev.question,
        askMs: ev.nowMs,
        firstWordMs: null,
        pulseMax: null,
        breathSum: 0,
        breathCount: 0,
        pacerShown: false,
        pacerShownAt: null,
        settledAt: null,
        expressionHint: null,
      };
      setMood(s, 'curious', ev.nowMs, true);
      say(s, `Question ${s.asked}. ${ev.question.topic}.`);
      return s;
    }

    case 'START_ANSWER': {
      enterAnswer(s, ev.nowMs, ev.nowMs);
      s.nowMs = ev.nowMs;
      return s;
    }

    case 'FINISH_ANSWER': {
      s.nowMs = ev.nowMs;
      enterBetween(s, ev.nowMs);
      return s;
    }

    case 'END_SESSION': {
      s.nowMs = ev.nowMs;
      if (s.phase === 'answer') finaliseQuestion(s, ev.nowMs);
      else if (s.phase === 'think') finaliseQuestion(s, ev.nowMs);
      s.phase = 'report';
      s.phaseStartMs = ev.nowMs;
      s.pacer = false;
      say(s, 'Viva ended. Your calm report is ready.');
      return s;
    }

    case 'RECALIBRATE': {
      s.phase = 'calibrating';
      s.phaseStartMs = ev.nowMs;
      s.nowMs = ev.nowMs;
      s.calibration = { startMs: ev.nowMs, pulse: [], breathing: [], hrv: [], doneMs: null };
      s.calibrationTimedOut = false;
      s.baseline = null;
      s.breathEma = null;
      s.breathEmaAt = null;
      s.pulseEma = null;
      s.pulseEmaAt = null;
      s.breathSeenAt = null;
      s.pulseSeenAt = null;
      s.lastPulseTs = null;
      s.lastBreathTs = null;
      s.current = null;
      s.calm = 0;
      say(s, 'Re-calibrating. Sit like you are waiting outside the lab.');
      return s;
    }

    case 'BACK_TO_CONSENT': {
      s.phase = 'consent';
      s.nowMs = ev.nowMs;
      s.current = null;
      s.pacer = false;
      s.calm = 0;
      return s;
    }
  }
}

// --- report -----------------------------------------------------------------

/** Build the on-disk record from the live state. */
export function buildSessionRecord(
  s: VivaState,
  opts: {
    /** wall-clock ms when the session began (Date.now), not the app clock */
    startedAt: number;
    endedAt: number;
    telemetryEnabled: boolean;
    appVersion: string;
    sdkVersion: string;
    id: string;
  },
): SessionRecord {
  const rmssd = median(s.hrvSession.map((h) => h.rmssd));
  const baevsky = median(s.hrvSession.map((h) => h.baevsky));
  return {
    id: opts.id,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    baseline:
      s.baseline ?? {
        pulse: null,
        breathing: null,
        rmssd: null,
        baevsky: null,
        pulseSamples: 0,
        breathingSamples: 0,
        hrvSamples: 0,
        capturedAt: opts.startedAt,
      },
    questions: s.results.slice(),
    timeline: s.timeline.slice(),
    sessionHrv: rmssd != null || baevsky != null ? { rmssd, baevsky } : null,
    telemetryEnabled: opts.telemetryEnabled,
    practiceOnly: s.practiceOnly,
    appVersion: opts.appVersion,
    sdkVersion: opts.sdkVersion,
  };
}

export interface ReportInsight {
  calmest: QuestionResult | null;
  spikiest: QuestionResult | null;
  /** questions where the pacer appeared and the room still settled */
  recoveries: QuestionResult[];
  avgLatencyMs: number | null;
  settledCount: number;
}

/** Pick the headline numbers for the Calm Report. */
export function summarise(record: SessionRecord): ReportInsight {
  const answered = record.questions.filter((q) => q.pulseDeltaPct != null || q.settled);
  const byDelta = record.questions
    .filter((q) => q.pulseDeltaPct != null)
    .sort((a, b) => (a.pulseDeltaPct ?? 0) - (b.pulseDeltaPct ?? 0));

  const latencies = record.questions
    .map((q) => q.answerLatencyMs)
    .filter((v): v is number => v != null);

  return {
    calmest: byDelta[0] ?? answered[0] ?? null,
    spikiest: byDelta.length ? byDelta[byDelta.length - 1] ?? null : null,
    recoveries: record.questions.filter((q) => q.pacerShown && q.settled),
    avgLatencyMs: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : null,
    settledCount: record.questions.filter((q) => q.settled).length,
  };
}
