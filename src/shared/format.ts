// src/shared/format.ts
// Number and time formatting shared by the room and the Calm Report.
// Deliberately dependency-free so the tests can import it in plain Node.

export function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} m ${rest} s` : `${m} m`;
}

export function fmtPct(n: number | null): string {
  if (n == null) return '—';
  const r = Math.round(n);
  if (r === 0) return '±0%';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)}%`;
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtNum(n: number | null, digits = 0): string {
  if (n == null) return '—';
  return n.toFixed(digits);
}
