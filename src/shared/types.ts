

export type Phase =
  | 'consent'
  | 'calibrating'
  | 'ready'
  | 'think'
  | 'answer'
  | 'between'
  | 'report';


export type Mood = 'neutral' | 'curious' | 'encouraging' | 'patient' | 'listening';


export type ChipState = 'live' | 'warming' | 'unreadable' | 'off';


export interface Sample {
  value: number;
  stable: boolean;
  confidence: number;
  tsMs: number;
}


export interface HrvSample {
  rmssd: number;
  meanNn: number;
  sdnn: number;
  baevsky: number;
  confidence: number;
  stable: boolean;
  tsMs: number;
}


export interface Snapshot {
  tsMs: number;
  pulse: Sample | null;
  breathing: Sample | null;
  hrv: HrvSample | null;
  talking: boolean | null;
  talkingStable: boolean;
  expression: { type: number; confidence: number } | null;
  upperTrace: number | null;
  blinking: boolean | null;
}


export interface SignalLogRow {
  t: number;
  sdkTsMs: number;
  phase: Phase;
  drive: 'breathing' | 'pulse' | 'none';
  pulseRaw: number | null;
  pulseStable: boolean;
  pulseConfidence: number;
  pulseEma: number | null;
  pulseDeltaPct: number | null;
  breathRaw: number | null;
  breathStable: boolean;
  breathConfidence: number;
  breathEma: number | null;
  breathDeltaPct: number | null;
  breathingChip: string;
  talking: boolean | null;
  talkingStable: boolean;
  validationCode: number | null;
  pacer: boolean;
  calm: number;
  mood: string;
  questionIndex: number;
  origin?: 'talking' | 'manual';
}


export interface ValidationState {
  code: number;
  hint: string;
  tsMs: number;
}


export interface Baseline {
  pulse: number | null;
  breathing: number | null;
  rmssd: number | null;
  baevsky: number | null;
  pulseSamples: number;
  breathingSamples: number;
  hrvSamples: number;
  capturedAt: number;
}


export interface TimelinePoint {
  t: number;
  pulse: number | null;
  breathing: number | null;
  q: number | null;
  phase: Phase;
}


export interface QuestionResult {
  questionId: string;
  topic: string;
  subject: string;
  module: string;
  question: string;
  askedAt: number;
  answerLatencyMs: number | null;
  answerMs: number;
  pulseMax: number | null;
  pulseDeltaPct: number | null;
  breathingThinkAvg: number | null;
  settled: boolean;
  recoveryMs: number | null;
  pacerShown: boolean;
  expressionHint: string | null;
}


export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  baseline: Baseline;
  questions: QuestionResult[];
  timeline: TimelinePoint[];
  sessionHrv: { rmssd: number | null; baevsky: number | null } | null;
  telemetryEnabled: boolean;
  practiceOnly: boolean;
  appVersion: string;
  sdkVersion: string;
  signalLogPath?: string;
}


export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  questionCount: number;
  practiceOnly: boolean;
  calmestTopic: string | null;
}


export interface Question {
  id: string;
  subject: string;
  subjectCode: string;
  module: string;
  topic: string;
  question: string;
  followUp: string;
  difficulty: 'warm-up' | 'core' | 'stretch';
}


export interface Settings {
  telemetry: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  roomSounds: boolean;
  autoDeleteDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  telemetry: false,
  reducedMotion: false,
  highContrast: false,
  roomSounds: false,
  autoDeleteDays: 0,
};


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
  logSnapshot(row: SignalLogRow): void;
  resetSignalLog(): Promise<{ ok: boolean }>;
  onMenu(command: string, cb: () => void): void;
}
