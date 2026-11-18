
import type { ChipState, HrvSample, Sample, Snapshot } from './types.ts';


type ProtoTs = number | { toNumber(): number } | null | undefined;


export function tsToMs(ts: ProtoTs): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts / 1000;
  if (typeof ts.toNumber === 'function') return ts.toNumber() / 1000;
  const n = Number(ts);
  return Number.isFinite(n) ? n / 1000 : 0;
}


export interface DecodedMeasurement {
  value?: number | null;
  stable?: boolean | null;
  confidence?: number | null;
  timestamp?: ProtoTs;
}

export interface DecodedDetection {
  detected?: boolean | null;
  stable?: boolean | null;
  timestamp?: ProtoTs;
}

export interface DecodedMetrics {
  breathing?: {
    rate?: DecodedMeasurement[] | null;
    upperTrace?: DecodedMeasurement[] | null;
    lowerTrace?: DecodedMeasurement[] | null;
  } | null;
  cardio?: {
    pulseRate?: DecodedMeasurement[] | null;
    hrv?: Array<{
      rmssd?: number | null;
      meanNn?: number | null;
      sdnn?: number | null;
      baevsky?: number | null;
      confidence?: number | null;
      stable?: boolean | null;
      timestamp?: ProtoTs;
    }> | null;
  } | null;
  face?: {
    talking?: DecodedDetection[] | null;
    blinking?: DecodedDetection[] | null;
    expression?: Array<{
      stable?: boolean | null;
      timestamp?: ProtoTs;
      scores?: Array<{ type?: number | null; confidence?: number | null }> | null;
    }> | null;
  } | null;
}


export const EXPRESSION_LABELS: Record<number, string> = {
  1: 'angry',
  2: 'contempt',
  3: 'disgust',
  4: 'fear',
  5: 'happy',
  6: 'neutral',
  7: 'sad',
  8: 'surprise',
};

function newest<T>(arr: T[] | null | undefined): T | null {
  if (!arr || arr.length === 0) return null;
  return arr[arr.length - 1] ?? null;
}

function toSample(m: DecodedMeasurement | null): Sample | null {
  if (!m || typeof m.value !== 'number' || !Number.isFinite(m.value)) return null;
  return {
    value: m.value,
    stable: m.stable === true,
    confidence: typeof m.confidence === 'number' ? m.confidence : 0,
    tsMs: tsToMs(m.timestamp),
  };
}

function toHrv(
  h: NonNullable<NonNullable<DecodedMetrics['cardio']>['hrv']>[number] | null,
): HrvSample | null {
  if (!h || typeof h.rmssd !== 'number') return null;
  return {
    rmssd: h.rmssd,
    meanNn: typeof h.meanNn === 'number' ? h.meanNn : 0,
    sdnn: typeof h.sdnn === 'number' ? h.sdnn : 0,
    baevsky: typeof h.baevsky === 'number' ? h.baevsky : 0,
    confidence: typeof h.confidence === 'number' ? h.confidence : 0,
    stable: h.stable === true,
    tsMs: tsToMs(h.timestamp),
  };
}


export function toSnapshot(decoded: DecodedMetrics | null, fallbackNowMs: number): Snapshot {
  const tsCandidates: number[] = [];
  const push = (v: number) => {
    if (v > 0) tsCandidates.push(v);
  };

  const pulse = toSample(newest(decoded?.cardio?.pulseRate));
  const breathing = toSample(newest(decoded?.breathing?.rate));
  const hrv = toHrv(newest(decoded?.cardio?.hrv));
  const talkingRaw = newest(decoded?.face?.talking);
  const blinkingRaw = newest(decoded?.face?.blinking);
  const exprRaw = newest(decoded?.face?.expression);
  const traceRaw = newest(decoded?.breathing?.upperTrace);

  if (pulse) push(pulse.tsMs);
  if (breathing) push(breathing.tsMs);
  if (hrv) push(hrv.tsMs);
  if (talkingRaw) push(tsToMs(talkingRaw.timestamp));

  let expression: Snapshot['expression'] = null;
  if (exprRaw?.scores?.length) {
    let best: { type: number; confidence: number } | null = null;
    for (const s of exprRaw.scores) {
      const type = typeof s.type === 'number' ? s.type : 0;
      const confidence = typeof s.confidence === 'number' ? s.confidence : 0;
      if (!best || confidence > best.confidence) best = { type, confidence };
    }
    expression = best;
  }

  return {
    tsMs: tsCandidates.length ? Math.max(...tsCandidates) : fallbackNowMs,
    pulse,
    breathing,
    hrv,
    talking: talkingRaw ? talkingRaw.detected === true : null,
    talkingStable: talkingRaw ? talkingRaw.stable === true : false,
    expression,
    upperTrace:
      traceRaw && typeof traceRaw.value === 'number' && Number.isFinite(traceRaw.value)
        ? traceRaw.value
        : null,
    blinking: blinkingRaw ? blinkingRaw.detected === true : null,
  };
}


export const USABLE_CONFIDENCE = 50;
export const PULSE_MIN = 40;
export const PULSE_MAX = 110;
export const BREATH_MIN = 5;
export const BREATH_MAX = 40;

export function pulseUsable(s: Sample | null): s is Sample {
  return (
    !!s &&
    s.stable &&
    s.confidence >= USABLE_CONFIDENCE &&
    s.value >= PULSE_MIN &&
    s.value <= PULSE_MAX
  );
}

export function breathingUsable(s: Sample | null): s is Sample {
  return (
    !!s &&
    s.stable &&
    s.confidence >= USABLE_CONFIDENCE &&
    s.value >= BREATH_MIN &&
    s.value <= BREATH_MAX
  );
}


export function ema(prev: number | null, next: number, dtSec: number, tauSec: number): number {
  if (prev == null) return next;
  if (!(dtSec > 0)) return prev;
  const alpha = 1 - Math.exp(-dtSec / tauSec);
  return prev + alpha * (next - prev);
}


export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}


export function deltaPct(value: number, baseline: number | null): number | null {
  if (baseline == null || baseline === 0) return null;
  return ((value - baseline) / baseline) * 100;
}


export function vsBaseline(value: number, baseline: number | null): string {
  const d = deltaPct(value, baseline);
  if (d == null) return 'no baseline yet';
  const rounded = Math.round(d);
  if (rounded === 0) return 'at your baseline';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}% vs your baseline`;
}

export interface ChipView {
  state: ChipState;
  label: string;
  /** big number, or an em dash when there is nothing to show */
  value: string;
  /** short text under the number */
  detail: string;
}

/**
 * Chip gating. Every rule from the plan lives here so the UI stays dumb:
 * confidence, stability, range, talking, and validation status.
 */
export function pulseChip(
  sample: Sample | null,
  smoothed: number | null,
  opts: { warming: boolean; validationOk: boolean },
): ChipView {
  if (sample == null && smoothed == null) {
    return {
      state: opts.warming ? 'warming' : 'unreadable',
      label: 'Pulse',
      value: '—',
      detail: opts.warming ? 'warming up' : "can't read right now",
    };
  }
  if (!pulseUsable(sample)) {
    return {
      state: opts.warming ? 'warming' : 'unreadable',
      label: 'Pulse',
      value: '—',
      detail: opts.warming ? 'warming up' : "can't read right now",
    };
  }
  const v = smoothed ?? sample.value;
  return {
    state: 'live',
    label: 'Pulse',
    value: `${Math.round(v)}`,
    detail: 'bpm · vs your baseline',
  };
}

export function breathingChip(
  sample: Sample | null,
  smoothed: number | null,
  opts: { warming: boolean; talking: boolean; validationOk: boolean },
): ChipView {
  if (opts.talking) {
    return {
      state: 'off',
      label: 'Breathing',
      value: '—',
      detail: 'paused while you talk',
    };
  }
  if (!breathingUsable(sample) || smoothed == null) {
    return {
      state: opts.warming ? 'warming' : 'unreadable',
      label: 'Breathing',
      value: '—',
      detail: opts.warming ? 'warming up' : "can't read right now",
    };
  }
  return {
    state: 'live',
    label: 'Breathing',
    value: `${smoothed.toFixed(1)}`,
    detail: 'breaths/min',
  };
}

export function faceChip(opts: {
  validationOk: boolean;
  hasFace: boolean;
  warming: boolean;
}): ChipView {
  if (!opts.hasFace && !opts.validationOk) {
    return {
      state: opts.warming ? 'warming' : 'unreadable',
      label: 'Face',
      value: '—',
      detail: opts.warming ? 'finding your face' : 'face not forward',
    };
  }
  if (!opts.validationOk) {
    return { state: 'unreadable', label: 'Face', value: '—', detail: 'face not forward' };
  }
  return { state: 'live', label: 'Face', value: 'ok', detail: 'framing is good' };
}
