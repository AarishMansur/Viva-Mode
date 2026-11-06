// src/shared/types.ts
// The data model shared by the main process, the preload bridge and the
// renderer. Nothing in here imports Electron or the SDK, so it is safe to
// unit-test in plain Node.

/** Where the viva currently is. Mirrors the reducer's state machine. */
export type Phase =
  | 'consent'
  | 'calibrating'
  | 'ready'
  | 'think'
  | 'answer'
  | 'between'
  | 'report';

/** Examiner avatar states. Four are moods; `listening` is a phase cue. */
export type Mood = 'neutral' | 'curious' | 'encouraging' | 'patient' | 'listening';

/** Visual state of a signal chip. */
export type ChipState = 'live' | 'warming' | 'unreadable' | 'off';

/** One usable sample from a `MeasurementWithConfidence` stream. */
export interface Sample {
  value: number;
  stable: boolean;
  confidence: number;
  tsMs: number;
}

/** One usable HRV sample. Kept out of the live UI; report only. */
export interface HrvSample {
  rmssd: number;
  meanNn: number;
  sdnn: number;
  baevsky: number;
  confidence: number;
  stable: boolean;
  tsMs: number;
}

/**
 * A normalised view of one decoded `Metrics` packet.
 *
 * The SDK's `metrics` event carries only the window since the previous emit,
 * so every field here is "the newest sample in this window, if any".
 */
export interface Snapshot {
  tsMs: number;
  pulse: Sample | null;
  breathing: Sample | null;
  hrv: HrvSample | null;
  /** `face.talking[].detected`, newest in window. null when absent. */
  talking: boolean | null;
  talkingStable: boolean;
  /** Highest-confidence expression in the newest `face.expression` entry. */
  expression: { type: number; confidence: number } | null;
  /** Newest chest breathing trace value (unitless), for the pacer's shape. */
  upperTrace: number | null;
  /** `face.blinking[].detected`, newest in window. */
  blinking: boolean | null;
}

/** Latest `validationStatus` from the SDK. */
export interface ValidationState {
  code: number;
  hint: string;
  tsMs: number;
}

/** Personal baseline captured during the 60 s calibration. */
export interface Baseline {
  pulse: number | null;
  breathing: number | null;
  rmssd: number | null;
  baevsky: number | null;
  /** How many usable samples each median was built from (for the report). */
  pulseSamples: number;
  breathingSamples: number;
  hrvSamples: number;
  capturedAt: number;
}

/** A point on the session timeline, sampled at ~1 Hz. */
export interface TimelinePoint {
  /** ms since session start */
  t: number;
  pulse: number | null;
  breathing: number | null;
  /** index into `SessionRecord.questions`, or null between questions */
  q: number | null;
  phase: Phase;
}

/** The result of one asked question. */
export interface QuestionResult {
  questionId: string;
  topic: string;
  subject: string;
  module: string;
  /** the question text, so the report reads on its own */
  question: string;
  askedAt: number;
  /** question shown -> first detected speech */
  answerLatencyMs: number | null;
  /** first detected speech -> answer considered finished */
  answerMs: number;
  /** highest smoothed pulse during the think phase */
  pulseMax: number | null;
  /** (pulseMax - baseline) / baseline, as a percentage */
  pulseDeltaPct: number | null;
  /** mean smoothed breathing rate during the think phase */
  breathingThinkAvg: number | null;
  /** true when the room reached "settled" before the answer started */
  settled: boolean;
  /** ms from pacer appearing to the room settling, when both happened */
  recoveryMs: number | null;
  /** whether the pacer was ever shown for this question */
  pacerShown: boolean;
  /** highest-confidence expression observed while answering (report only) */
  expressionHint: string | null;
}

/** A whole session. This is what gets written to disk. */
export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  baseline: Baseline;
  questions: QuestionResult[];
  timeline: TimelinePoint[];
  /** HRV medians seen during the session, if it was ever stable. Report only. */
  sessionHrv: { rmssd: number | null; baevsky: number | null } | null;
  telemetryEnabled: boolean;
  /** true when the session ran without vitals (questions only) */
  practiceOnly: boolean;
  appVersion: string;
  sdkVersion: string;
}

/** Trimmed session for the history list. */
export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  questionCount: number;
  practiceOnly: boolean;
  /** calmest question topic, if any */
  calmestTopic: string | null;
}

/** One entry in the question bank. */
export interface Question {
  id: string;
  subject: string;
  subjectCode: string;
  module: string;
  topic: string;
  question: string;
  /** a short follow-up the examiner may ask after a calm answer */
  followUp: string;
  difficulty: 'warm-up' | 'core' | 'stretch';
}

/** User-facing preferences. Persisted in userData/settings.json. */
export interface Settings {
  /** Send the SDK's aggregate telemetry. Off unless the user opts in. */
  telemetry: boolean;
  /** Disable non-essential animation. Mirrors prefers-reduced-motion. */
  reducedMotion: boolean;
  /** Higher-contrast palette. */
  highContrast: boolean;
  /** Room tick / settle sounds. */
  roomSounds: boolean;
  /** Auto-delete sessions older than this many days. 0 = keep forever. */
  autoDeleteDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  telemetry: false,
  reducedMotion: false,
  highContrast: false,
  roomSounds: false,
  autoDeleteDays: 0,
};

/** What the renderer needs to boot. */
export interface AppConfig {
  hasApiKey: boolean;
  apiKeySource: 'settings' | 'env' | 'none';
  settings: Settings;
  questions: Question[];
  appVersion: string;
  sdkVersion: string;
  dataDir: string;
  platform: string;
}

/** The bridge exposed on `window.viva` by the preload script. */
export interface VivaBridge {
  getConfig(): Promise<AppConfig>;
  getApiKey(): Promise<string | null>;
  setApiKey(key: string): Promise<{ ok: boolean }>;
  clearApiKey(): Promise<{ ok: boolean }>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  saveSession(record: SessionRecord): Promise<{ id: string }>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<{ ok: boolean }>;
  deleteAllData(): Promise<{ ok: boolean }>;
  openDataFolder(): Promise<{ ok: boolean }>;
  savePng(dataUrl: string, suggestedName: string): Promise<{ ok: boolean; path?: string }>;
  log(line: string): void;
  onMenu(command: string, cb: () => void): void;
}
