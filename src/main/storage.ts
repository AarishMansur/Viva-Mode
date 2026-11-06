// src/main/storage.ts
// Local-only persistence. Everything lives under app.getPath('userData'):
//
//   userData/
//     settings.json        preferences (no vitals)
//     api-key.bin          OS-encrypted API key (safeStorage), never leaves disk
//     sessions/<id>.json   one file per viva, summaries only
//
// There is no database, no account, and no network write. "Delete all my data"
// removes the whole tree and recreates an empty one.

import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type {
  SessionRecord,
  SessionSummary,
  Settings,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

const KEY_FILE = 'api-key.bin';
const KEY_PLAIN_FILE = 'api-key.txt';
const SETTINGS_FILE = 'settings.json';

export function dataDir(): string {
  return app.getPath('userData');
}

export function sessionsDir(): string {
  return path.join(dataDir(), 'sessions');
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// --- settings ---------------------------------------------------------------

export async function loadSettings(): Promise<Settings> {
  await ensureDirs();
  const stored = await readJson<Partial<Settings>>(path.join(dataDir(), SETTINGS_FILE));
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await ensureDirs();
  await writeJson(path.join(dataDir(), SETTINGS_FILE), next);
  return next;
}

// --- api key ----------------------------------------------------------------
// Encrypted with the OS keystore (DPAPI on Windows, Keychain on macOS,
// libsecret on Linux). Falls back to a plaintext file only when the platform
// has no keystore, and says so in the UI.

export async function saveApiKey(key: string): Promise<void> {
  await ensureDirs();
  const trimmed = key.trim();
  if (!trimmed) return clearApiKey();
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(trimmed);
    await fs.writeFile(path.join(dataDir(), KEY_FILE), buf);
    await fs.rm(path.join(dataDir(), KEY_PLAIN_FILE), { force: true });
    return;
  }
  await fs.writeFile(path.join(dataDir(), KEY_PLAIN_FILE), trimmed, 'utf8');
}

export async function readApiKey(): Promise<{ key: string | null; source: 'settings' | 'env' | 'none' }> {
  try {
    const enc = await fs.readFile(path.join(dataDir(), KEY_FILE));
    if (safeStorage.isEncryptionAvailable()) {
      const key = safeStorage.decryptString(enc).trim();
      if (key) return { key, source: 'settings' };
    }
  } catch {
    /* no encrypted key on disk */
  }
  try {
    const plain = (await fs.readFile(path.join(dataDir(), KEY_PLAIN_FILE), 'utf8')).trim();
    if (plain) return { key: plain, source: 'settings' };
  } catch {
    /* no plaintext key on disk */
  }
  const fromEnv = (process.env.PRESAGE_API_KEY ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { key: null, source: 'none' };
}

export async function clearApiKey(): Promise<void> {
  await fs.rm(path.join(dataDir(), KEY_FILE), { force: true });
  await fs.rm(path.join(dataDir(), KEY_PLAIN_FILE), { force: true });
}

// --- sessions ---------------------------------------------------------------

export function newSessionId(at = Date.now()): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function safeId(id: string): string {
  // Never let a crafted id escape the sessions directory.
  return id.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
}

export async function saveSession(record: SessionRecord): Promise<string> {
  await ensureDirs();
  const id = safeId(record.id || newSessionId(record.startedAt || Date.now()));
  await writeJson(path.join(sessionsDir(), `${id}.json`), { ...record, id });
  return id;
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  return readJson<SessionRecord>(path.join(sessionsDir(), `${safeId(id)}.json`));
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await fs.rm(path.join(sessionsDir(), `${safeId(id)}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

function summarise(record: SessionRecord): SessionSummary {
  const calmest = record.questions
    .filter((q) => q.pulseDeltaPct != null)
    .sort((a, b) => (a.pulseDeltaPct ?? 0) - (b.pulseDeltaPct ?? 0))[0];
  return {
    id: record.id,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    questionCount: record.questions.length,
    practiceOnly: record.practiceOnly,
    calmestTopic: calmest?.topic ?? null,
  };
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureDirs();
  let names: string[] = [];
  try {
    names = await fs.readdir(sessionsDir());
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rec = await readJson<SessionRecord>(path.join(sessionsDir(), name));
    if (rec) out.push(summarise(rec));
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Remove sessions older than `days`. Returns how many files went away. */
export async function purgeOlderThan(days: number): Promise<number> {
  if (!(days > 0)) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  try {
    const names = await fs.readdir(sessionsDir());
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(sessionsDir(), name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(full, { force: true });
        removed += 1;
      }
    }
  } catch {
    /* nothing to purge */
  }
  return removed;
}

/** Wipe every trace of the app's data, then recreate an empty tree. */
export async function deleteAllData(): Promise<void> {
  const dir = dataDir();
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }
  // Only touch our own files, never anything else Electron keeps in userData.
  const ours = new Set(['sessions', SETTINGS_FILE, KEY_FILE, KEY_PLAIN_FILE]);
  for (const name of names) {
    if (!ours.has(name)) continue;
    await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
  await ensureDirs();
}
