// test/stateMachine.test.ts
// Camera-free tests for the adaptive logic. Run with `npm test` (node:test +
// Node's built-in TypeScript type stripping).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  T,
  step,
  initialState,
  buildSessionRecord,
  summarise,
  calibrationProgress,
  type VivaState,
} from '../src/shared/stateMachine.ts';
import {
  toSnapshot,
  pulseChip,
  breathingChip,
  median,
  ema,
  pulseUsable,
} from '../src/shared/signals.ts';
import type { Question, Snapshot } from '../src/shared/types.ts';
import { remarkFor } from '../src/shared/remarks.ts';

const T0 = 1_000_000;
let sdkClock = 5_000_000;

interface SnapOpts {
  pulse?: number;
  breath?: number;
  talking?: boolean;
  confidence?: number;
  stable?: boolean;
  hrv?: boolean;
}

function mkSnap(t: number, o: SnapOpts = {}): Snapshot {
  sdkClock += 1000;
  const confidence = o.confidence ?? 90;
  const stable = o.stable ?? true;
  return {
    tsMs: t,
    pulse:
      o.pulse != null
        ? { value: o.pulse, stable, confidence, tsMs: sdkClock }
        : null,
    breathing:
      o.breath != null
        ? { value: o.breath, stable, confidence, tsMs: sdkClock }
        : null,
    hrv: o.hrv
      ? { rmssd: 42, meanNn: 850, sdnn: 55, baevsky: 120, confidence: 80, stable: true, tsMs: sdkClock }
      : null,
    talking: o.talking ?? null,
    talkingStable: true,
    expression: null,
    upperTrace: null,
    blinking: null,
  };
}

function begin(nowMs = T0): VivaState {
  return step(initialState(nowMs), { type: 'CONSENT_GIVEN', nowMs });
}

/** 62 seconds of steady samples, one per second. */
function calibrate(pulse = 70, breath = 14, nowMs = T0): VivaState {
  const s = begin(nowMs);
  for (let i = 1; i <= 62; i++) {
    step(s, { type: 'SNAPSHOT', snap: mkSnap(nowMs + i * 1000, { pulse, breath }) });
    step(s, { type: 'TICK', nowMs: nowMs + i * 1000 });
  }
  return s;
}

const Q: Question = {
  id: 'q1',
  subject: 'Operating Systems',
  subjectCode: 'BCS303',
  module: 'Module 3',
  topic: 'Deadlocks',
  question: 'What are the four necessary conditions for a deadlock?',
  followUp: 'How would a resource-allocation graph show you one?',
  difficulty: 'core',
};

/** Drive the machine at 4 Hz, emitting one snapshot per step. */
function run(
  s: VivaState,
  startMs: number,
  secs: number,
  opts: (elapsedSec: number) => SnapOpts,
): number {
  const steps = Math.round(secs * 4);
  for (let i = 1; i <= steps; i++) {
    const t = startMs + i * 250;
    step(s, { type: 'SNAPSHOT', snap: mkSnap(t, opts(i * 0.25)) });
    step(s, { type: 'TICK', nowMs: t });
  }
  return startMs + steps * 250;
}

/** Let a test set the EMA exactly on the first sample of the think phase. */
function resetBreathEma(s: VivaState): void {
  s.breathEma = null;
  s.breathEmaAt = null;
  s.breathSeenAt = null;
  s.lastBreathTs = null;
}

// ── calibration ─────────────────────────────────────────────────────────────

test('calibration needs both the 60 s floor and 20 usable pulse samples', () => {
  const s = begin();
  // 40 s of perfect samples is not enough — the clock gate wins.
  for (let i = 1; i <= 40; i++) {
    step(s, { type: 'SNAPSHOT', snap: mkSnap(T0 + i * 1000, { pulse: 70, breath: 14 }) });
    step(s, { type: 'TICK', nowMs: T0 + i * 1000 });
  }
  assert.equal(s.phase, 'calibrating');

  // 60 s in total, but only 5 usable pulse samples: still calibrating.
  const sparse = begin();
  for (let i = 1; i <= 60; i++) {
    step(sparse, { type: 'TICK', nowMs: T0 + i * 1000 });
    if (i % 12 === 0) {
      step(sparse, { type: 'SNAPSHOT', snap: mkSnap(T0 + i * 1000, { pulse: 70 }) });
    }
  }
  assert.equal(sparse.phase, 'calibrating');
  assert.equal(calibrationProgress(sparse).pulseSamples, 5);
});

test('calibration locks a median baseline and moves to ready', () => {
  const s = calibrate(70, 14);
  assert.equal(s.phase, 'ready');
  assert.equal(s.baseline?.pulse, 70);
  assert.equal(s.baseline?.breathing, 14);
  assert.ok((s.baseline?.pulseSamples ?? 0) >= 20);
});

test('calibration offers practice mode after 120 s without a usable pulse', () => {
  const s = begin();
  for (let i = 1; i <= 121; i++) step(s, { type: 'TICK', nowMs: T0 + i * 1000 });
  assert.equal(s.phase, 'calibrating');
  assert.equal(s.calibrationTimedOut, true);
});

// ── phase transitions ───────────────────────────────────────────────────────

test('1.2 s of talking flips Think to Answer', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  assert.equal(s.phase, 'think');

  run(s, T0 + 62_000, 1.0, () => ({ talking: true, pulse: 70, breath: 14 }));
  assert.equal(s.phase, 'think', '1.0 s of talking is not enough');

  run(s, T0 + 63_000, 0.5, () => ({ talking: true, pulse: 70, breath: 14 }));
  assert.equal(s.phase, 'answer');
});

test('4 s of silence ends the answer and records the question', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });

  // Three seconds of thinking, then two seconds of talking.
  let t = run(s, T0 + 62_000, 3, () => ({ talking: false, pulse: 70, breath: 14 }));
  assert.equal(s.phase, 'think');
  t = run(s, t, 2, () => ({ talking: true, pulse: 70, breath: 14 }));
  assert.equal(s.phase, 'answer');

  t = run(s, t, 3.5, () => ({ talking: false, pulse: 70, breath: 14 }));
  assert.equal(s.phase, 'answer', '3.5 s of silence is not enough');

  run(s, t, 1.0, () => ({ talking: false, pulse: 70, breath: 14 }));
  assert.equal(s.phase, 'between');
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0]?.topic, 'Deadlocks');
  assert.ok((s.results[0]?.answerLatencyMs ?? 0) >= 3000, 'latency is measured from the start of speech');
});

test('manual controls work when face detection never arrives', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  step(s, { type: 'START_ANSWER', nowMs: T0 + 70_000 });
  assert.equal(s.phase, 'answer');
  step(s, { type: 'FINISH_ANSWER', nowMs: T0 + 80_000 });
  assert.equal(s.phase, 'between');
  assert.equal(s.results.length, 1);
});

// ── the adaptive room ───────────────────────────────────────────────────────

test('elevated breathing shows the pacer', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  resetBreathEma(s);
  run(s, T0 + 62_000, 3, () => ({ breath: 20, pulse: 70 }));
  assert.equal(s.pacer, true);
  assert.equal(s.mood, 'patient');
});

test('settled breathing calms the room, one bounded step at a time', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  resetBreathEma(s);

  let t = T0 + 62_000;
  let previous = s.calm;
  let maxJump = 0;
  for (let i = 1; i <= 80; i++) {
    t = T0 + 62_000 + i * 250;
    step(s, { type: 'SNAPSHOT', snap: mkSnap(t, { breath: 14, pulse: 70 }) });
    step(s, { type: 'TICK', nowMs: t });
    maxJump = Math.max(maxJump, Math.abs(s.calm - previous));
    previous = s.calm;
  }

  assert.ok(s.calm > 0.2, `calm should climb, got ${s.calm}`);
  assert.ok(maxJump <= T.CALM_MAX_STEP + 1e-9, `calm jumped ${maxJump} in one tick`);
  assert.equal(s.mood, 'encouraging');
});

test('the 5–15% hysteresis band neither calms nor spikes', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  resetBreathEma(s);
  // 10% above baseline: inside the band.
  run(s, T0 + 62_000, 20, () => ({ breath: 14 * 1.1, pulse: 70 }));
  assert.equal(s.pacer, false, 'pacer must not fire inside the band');
  assert.equal(s.calm, 0, 'the room must not calm inside the band');
});

test('the pacer hides once breathing settles, and a cooldown applies', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  resetBreathEma(s);

  let t = run(s, T0 + 62_000, 4, () => ({ breath: 20, pulse: 70 }));
  assert.equal(s.pacer, true);

  // The EMA has a 10 s time constant, so settling takes a little while. Give
  // it up to 60 s and stop as soon as the pacer steps aside.
  for (let i = 0; i < 60 && s.pacer; i++) {
    t = run(s, t, 1, () => ({ breath: 14, pulse: 70 }));
  }
  assert.equal(s.pacer, false, 'the pacer must hide once breathing is back in band');
  assert.ok(s.pacerCooldownUntil > t - 1000, 'a cooldown starts when the pacer hides');
  assert.ok(s.calm > 0, 'the room should have calmed a little by now');
});

test('breathing is not smoothed while you are talking', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  resetBreathEma(s);

  run(s, T0 + 62_000, 3, () => ({ breath: 14, pulse: 70, talking: false }));
  const before = s.breathEma;
  assert.ok(before != null);

  run(s, T0 + 65_000, 2, () => ({ breath: 32, pulse: 70, talking: true }));
  assert.equal(s.breathEma, before, 'a talking packet must not move the breathing EMA');
});

test('missing breathing drifts the room toward neutral instead of punishing it', () => {
  const s = calibrate();
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  s.calm = 0.9;
  resetBreathEma(s);
  // No breathing samples at all, only pulse.
  run(s, T0 + 62_000, 20, () => ({ pulse: 70 }));
  assert.ok(Math.abs(s.calm - T.ROOM_NEUTRAL) < 0.1, `calm drifted to ${s.calm}`);
  assert.equal(s.pacer, false);
});

test('pulse drives the room when breathing was never usable', () => {
  const s = begin();
  // Calibrate with pulse only, so baseline.breathing stays null.
  for (let i = 1; i <= 62; i++) {
    step(s, { type: 'SNAPSHOT', snap: mkSnap(T0 + i * 1000, { pulse: 70 }) });
    step(s, { type: 'TICK', nowMs: T0 + i * 1000 });
  }
  assert.equal(s.phase, 'ready');
  assert.equal(s.baseline?.breathing, null);

  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  run(s, T0 + 62_000, 12, () => ({ pulse: 70 * 1.3 }));
  assert.equal(s.drive, 'pulse');
  assert.equal(s.pacer, true);
});

// ── signals ─────────────────────────────────────────────────────────────────

test('chip gating follows confidence, stability and range', () => {
  const good = pulseChip(
    { value: 72, stable: true, confidence: 80, tsMs: 0 },
    72,
    { warming: false, validationOk: true },
  );
  assert.equal(good.state, 'live');

  const lowConfidence = pulseChip(
    { value: 72, stable: true, confidence: 40, tsMs: 0 },
    72,
    { warming: false, validationOk: true },
  );
  assert.equal(lowConfidence.state, 'unreadable');

  const outOfRange = pulseChip(
    { value: 130, stable: true, confidence: 90, tsMs: 0 },
    130,
    { warming: false, validationOk: true },
  );
  assert.equal(outOfRange.state, 'unreadable');

  const warming = pulseChip(null, null, { warming: true, validationOk: true });
  assert.equal(warming.detail, 'warming up');

  const talking = breathingChip(
    { value: 14, stable: true, confidence: 90, tsMs: 0 },
    14,
    { warming: false, talking: true, validationOk: true },
  );
  assert.equal(talking.state, 'off');
  assert.equal(talking.detail, 'paused while you talk');
});

test('usability rejects the SDK out-of-range band', () => {
  assert.equal(pulseUsable({ value: 39, stable: true, confidence: 90, tsMs: 0 }), false);
  assert.equal(pulseUsable({ value: 111, stable: true, confidence: 90, tsMs: 0 }), false);
  assert.equal(pulseUsable({ value: 72, stable: false, confidence: 90, tsMs: 0 }), false);
  assert.equal(pulseUsable({ value: 72, stable: true, confidence: 50, tsMs: 0 }), true);
});

test('EMA respects its time constant and median handles even lengths', () => {
  const a = ema(null, 100, 1, 10);
  assert.equal(a, 100);
  const b = ema(100, 200, 10, 10);
  assert.ok(Math.abs(b - 163.2) < 0.5, `got ${b}`);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('toSnapshot takes the newest entry of a windowed packet', () => {
  const snap = toSnapshot(
    {
      breathing: {
        rate: [
          { value: 12, stable: true, confidence: 70, timestamp: 1_000_000 },
          { value: 15, stable: true, confidence: 80, timestamp: 2_000_000 },
        ],
      },
      cardio: { pulseRate: [{ value: 68, stable: true, confidence: 90, timestamp: 2_000_000 }] },
      face: {
        talking: [{ detected: true, stable: true, timestamp: 2_000_000 }],
        expression: [{ stable: true, timestamp: 2_000_000, scores: [{ type: 6, confidence: 80 }, { type: 5, confidence: 20 }] }],
      },
    },
    999,
  );
  assert.equal(snap.breathing?.value, 15);
  assert.equal(snap.pulse?.value, 68);
  assert.equal(snap.talking, true);
  assert.deepEqual(snap.expression, { type: 6, confidence: 80 });
});

// ── report ──────────────────────────────────────────────────────────────────

test('the report picks the calmest and spikiest questions', () => {
  const s = calibrate();

  // Question 1 runs a little hot, question 2 sits close to baseline.
  step(s, { type: 'NEXT_QUESTION', question: Q, nowMs: T0 + 62_000 });
  let t = run(s, T0 + 62_000, 2, () => ({ pulse: 84, breath: 18 }));
  step(s, { type: 'START_ANSWER', nowMs: t });
  step(s, { type: 'FINISH_ANSWER', nowMs: t + 6_000 });

  const second: Question = { ...Q, id: 'q2', topic: 'Normalisation' };
  step(s, { type: 'NEXT_QUESTION', question: second, nowMs: t + 10_000 });
  t = run(s, t + 10_000, 2, () => ({ pulse: 68, breath: 14 }));
  step(s, { type: 'START_ANSWER', nowMs: t });
  step(s, { type: 'FINISH_ANSWER', nowMs: t + 6_000 });

  const record = buildSessionRecord(s, {
    startedAt: Date.now(),
    endedAt: Date.now() + 1000,
    telemetryEnabled: false,
    appVersion: '1.0.0',
    sdkVersion: '3.4.0',
    id: 'test',
  });

  assert.equal(record.questions.length, 2);
  assert.equal(record.practiceOnly, false);
  assert.ok(Array.isArray(record.timeline));

  const insight = summarise(record);
  assert.equal(insight.calmest?.topic, 'Normalisation');
  assert.equal(insight.spikiest?.topic, 'Deadlocks');
  assert.ok(insight.avgLatencyMs != null);
});

test('report copy never uses clinical language', () => {
  const banned = [
    /\bstress(ed|ful)?\b/i,
    /\banxious\b/i,
    /\banxiety\b/i,
    /\bunhealthy\b/i,
    /\babnormal\b/i,
    /\bdiagnos/i,
    /\btreatment\b/i,
    /\bcure\b/i,
    /\byour heart is\b/i,
    /\bdisorder\b/i,
  ];

  const samples = [
    remarkFor({
      questionId: 'x',
      topic: 'Deadlocks',
      subject: 'OS',
      module: 'M3',
      question: 'q',
      askedAt: 0,
      answerLatencyMs: 4000,
      answerMs: 9000,
      pulseMax: 88,
      pulseDeltaPct: 26,
      breathingThinkAvg: 16,
      settled: false,
      recoveryMs: null,
      pacerShown: true,
      expressionHint: null,
    }),
    remarkFor({
      questionId: 'y',
      topic: 'ACID',
      subject: 'DBMS',
      module: 'M4',
      question: 'q',
      askedAt: 0,
      answerLatencyMs: 3000,
      answerMs: 5000,
      pulseMax: 71,
      pulseDeltaPct: 1,
      breathingThinkAvg: 14,
      settled: true,
      recoveryMs: 22_000,
      pacerShown: true,
      expressionHint: null,
    }),
  ];

  for (const text of samples) {
    for (const re of banned) assert.ok(!re.test(text), `banned phrase in: ${text}`);
  }
});
