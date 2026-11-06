// src/renderer/report.ts
// The private Calm Report: a session timeline with question markers, baseline
// vs session numbers, and one card per question.
//
// Copy rules, enforced by review and by `test/copy.test.ts`:
//   always relative ("vs your baseline", "settled back"), never clinical.

import { Chart } from 'chart.js/auto';
import type { QuestionResult, SessionRecord } from '../shared/types';
import { summarise } from '../shared/stateMachine';
import { fmtClock, fmtDuration, fmtPct } from '../shared/format';
import { remarkFor } from '../shared/remarks';

// Re-exported so the renderer has one place to pull report formatting from.
export { fmtClock, fmtDuration, fmtPct, remarkFor };

function nearBaseline(deltaPct: number | null): boolean {
  return deltaPct != null && Math.abs(deltaPct) < 3;
}

// --- chart ------------------------------------------------------------------

let chart: Chart | null = null;

interface MarkerOptions {
  starts: Array<{ x: number; n: number }>;
}

function markerPlugin(options: MarkerOptions) {
  return {
    id: 'vivaQuestionMarkers',
    afterDatasetsDraw(c: Chart) {
      const { ctx, chartArea, scales } = c;
      const xScale = scales['x'];
      if (!xScale) return;
      ctx.save();
      for (const m of options.starts) {
        const px = xScale.getPixelForValue(m.x);
        if (!Number.isFinite(px) || px < chartArea.left || px > chartArea.right) continue;
        ctx.beginPath();
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = 'rgba(180,131,20,0.5)';
        ctx.lineWidth = 1;
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(138,90,0,0.9)';
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`Q${m.n}`, px, chartArea.top - 6);
      }
      ctx.restore();
    },
  };
}

function drawChart(record: SessionRecord): void {
  const canvas = document.getElementById('chart') as HTMLCanvasElement | null;
  if (!canvas) return;
  if (chart) {
    chart.destroy();
    chart = null;
  }

  const pulse = record.timeline
    .filter((p) => p.pulse != null)
    .map((p) => ({ x: p.t / 1000, y: p.pulse as number }));
  const breath = record.timeline
    .filter((p) => p.breathing != null)
    .map((p) => ({ x: p.t / 1000, y: p.breathing as number }));

  // Question markers. `askedAt` is on the app clock, and so is the timeline's
  // zero, so the offset is recoverable from the record itself.
  const origin =
    record.questions.length > 0
      ? (record.questions[0]?.askedAt ?? 0) - (record.timeline[0]?.t ?? 0)
      : 0;
  const starts = record.questions.map((q, i) => ({
    x: (q.askedAt - origin) / 1000,
    n: i + 1,
  }));

  chart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Pulse (bpm)',
          data: pulse,
          borderColor: '#cf5b45',
          backgroundColor: 'rgba(207,91,69,0.10)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.32,
          fill: true,
          yAxisID: 'y',
        },
        {
          label: 'Breathing (per min)',
          data: breath,
          borderColor: '#1f8a70',
          backgroundColor: 'rgba(31,138,112,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.32,
          spanGaps: false,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0f172a',
          bodyColor: '#475569',
          borderColor: '#e4e7ec',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            title: (items) => {
              const x = items[0]?.parsed?.x ?? 0;
              return `${fmtClock(x * 1000)} into the viva`;
            },
            label: (item) =>
              `${item.dataset.label}: ${(item.parsed.y as number).toFixed(1)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          grid: { color: 'rgba(15,23,42,0.07)' },
          ticks: {
            color: '#64748b',
            callback: (v) => fmtClock(Number(v) * 1000),
            maxTicksLimit: 8,
          },
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(15,23,42,0.07)' },
          ticks: { color: '#b4442f', maxTicksLimit: 6 },
          title: { display: true, text: 'bpm', color: '#64748b' },
        },
        y1: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#0f7a5a', maxTicksLimit: 6 },
          title: { display: true, text: 'breaths/min', color: '#64748b' },
        },
      },
    },
    plugins: [markerPlugin({ starts })],
  });
}

// --- report -----------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

export function renderReport(record: SessionRecord): void {
  const insight = summarise(record);
  const when = new Date(record.startedAt);
  const duration = record.endedAt - record.startedAt;

  const root = document.getElementById('report-root');
  root?.classList.toggle('report--practice', record.practiceOnly);
  const note = document.getElementById('report-practice-note');
  if (note) note.hidden = !record.practiceOnly;

  const peak = record.questions.reduce<number | null>(
    (max, q) => (q.pulseMax != null ? Math.max(max ?? 0, q.pulseMax) : max),
    null,
  );
  const peakDelta =
    peak != null && record.baseline.pulse != null
      ? ((peak - record.baseline.pulse) / record.baseline.pulse) * 100
      : null;

  setText(
    'report-meta',
    `${when.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })} · ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${fmtDuration(
      duration,
    )} · ${record.questions.length} question${record.questions.length === 1 ? '' : 's'}`,
  );

  // headline
  const bits: string[] = [];
  if (record.practiceOnly) {
    bits.push('Practice session — questions only, no vitals recorded.');
  }
  if (insight.calmest) {
    const c = insight.calmest;
    const phrase = nearBaseline(c.pulseDeltaPct)
      ? 'pulse within 3% of your baseline'
      : `closest to your baseline at ${fmtPct(c.pulseDeltaPct)}`;
    bits.push(`Your calmest answer: <b>${escapeHtml(c.topic)}</b> — ${phrase}.`);
  }
  if (insight.spikiest && insight.spikiest !== insight.calmest) {
    const s = insight.spikiest;
    if (s.pulseDeltaPct != null) {
      bits.push(
        `Biggest spike: <b>${escapeHtml(s.topic)}</b> at ${fmtPct(s.pulseDeltaPct)}.`,
      );
    }
  }
  if (insight.recoveries.length > 0) {
    bits.push(
      `You noticed and recovered <b>${insight.recoveries.length}</b> time${
        insight.recoveries.length === 1 ? '' : 's'
      }.`,
    );
  }
  if (bits.length === 0) bits.push('No vitals were recorded for this session.');

  const headline = el('report-headline');
  if (headline) headline.innerHTML = bits.join(' ');

  // three tiles, like the dashboard's overview numbers
  const tiles = el('report-tiles');
  if (tiles) {
    const rows: Array<[string, string]> = [
      ['Questions answered', String(record.questions.length)],
      ['Avg. time to first word', fmtDuration(insight.avgLatencyMs)],
      record.practiceOnly
        ? ['Vitals', 'not recorded']
        : [
            'Settled back',
            `${insight.settledCount} of ${record.questions.length}`,
          ],
    ];
    tiles.innerHTML = rows
      .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join('');
  }

  // stats
  const stats = el('report-stats');
  if (stats) {
    const b = record.baseline;

    const rows: Array<[string, string]> = [
      [
        'Baseline pulse',
        b.pulse != null ? `${Math.round(b.pulse)} bpm · ${b.pulseSamples} samples` : 'not captured',
      ],
      [
        'Baseline breathing',
        b.breathing != null
          ? `${b.breathing.toFixed(1)} /min · ${b.breathingSamples} samples`
          : 'not captured',
      ],
      ['Peak pulse', peak != null ? `${Math.round(peak)} bpm (${fmtPct(peakDelta)})` : '—'],
      [
        'Settled back',
        `${insight.settledCount} of ${record.questions.length} question${
          record.questions.length === 1 ? '' : 's'
        }`,
      ],
      ['Average time to first word', fmtDuration(insight.avgLatencyMs)],
    ];

    if (record.sessionHrv?.baevsky != null && b.baevsky != null && b.baevsky !== 0) {
      const d = ((record.sessionHrv.baevsky - b.baevsky) / b.baevsky) * 100;
      rows.push([
        'Baevsky index',
        Math.abs(d) < 10 ? 'about the same as your baseline' : `${d > 0 ? '↑' : '↓'} vs your baseline`,
      ]);
    }

    stats.innerHTML = rows
      .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join('');
  }

  // question cards
  const grid = el('report-questions');
  if (grid) {
    if (record.questions.length === 0) {
      grid.innerHTML = '<p class="muted">No questions were answered in this session.</p>';
    } else {
      grid.innerHTML = record.questions
        .map((q, i) => {
          const tags: string[] = [];
          if (!record.practiceOnly) {
            if (q.settled) tags.push('<span class="qres__tag">settled</span>');
            if (q.pulseDeltaPct != null && q.pulseDeltaPct > 10) {
              tags.push(
                `<span class="qres__tag qres__tag--spike">pulse ${fmtPct(q.pulseDeltaPct)}</span>`,
              );
            }
            if (q.pacerShown && q.settled) {
              tags.push(
                `<span class="qres__tag qres__tag--recover">recovered in ${fmtDuration(
                  q.recoveryMs,
                )}</span>`,
              );
            }
          }

          const rows: Array<[string, string]> = [
            ['Time to first word', fmtDuration(q.answerLatencyMs)],
            ['Answer length', fmtDuration(q.answerMs)],
          ];
          if (!record.practiceOnly) {
            rows.push(
              ['Peak pulse', q.pulseMax != null ? `${Math.round(q.pulseMax)} bpm` : '—'],
              ['vs baseline', fmtPct(q.pulseDeltaPct)],
              [
                'Breathing while thinking',
                q.breathingThinkAvg != null ? `${q.breathingThinkAvg.toFixed(1)} /min` : '—',
              ],
            );
          }

          return `
            <article class="qres">
              <div class="qres__head">
                <span class="qres__topic">${escapeHtml(q.topic)}</span>
                <span class="qres__subject">Q${i + 1} · ${escapeHtml(q.subject)}</span>
              </div>
              <p class="qres__q">${escapeHtml(q.question)}</p>
              <div class="qres__rows">
                ${rows
                  .map(
                    ([k, v]) =>
                      `<div class="qres__row"><span>${escapeHtml(k)}</span><span>${escapeHtml(
                        v,
                      )}</span></div>`,
                  )
                  .join('')}
              </div>
              ${tags.length ? `<div class="qres__tags">${tags.join(' ')}</div>` : ''}
              <p class="qres__remark">${escapeHtml(remarkFor(q))}</p>
            </article>`;
        })
        .join('');
    }
  }

  setText(
    'report-foot-meta',
    `Viva Mode ${record.appVersion} · SmartSpectra ${record.sdkVersion} · telemetry ${
      record.telemetryEnabled ? 'on' : 'off'
    } · stored in this app's data folder only`,
  );

  if (record.practiceOnly) {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  } else {
    drawChart(record);
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- PNG export -------------------------------------------------------------
// Drawn by hand with Canvas 2D so there is no extra dependency and the export
// is a single, self-contained card. Never auto-shared: the user picks a path.

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function buildReportPng(record: SessionRecord): string {
  const W = 1200;
  const rowH = 92;
  const top = 300;
  const H = top + record.questions.length * rowH + 150;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // background
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1b2530');
  g.addColorStop(1, '#131a20');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const pad = 64;

  ctx.fillStyle = '#e8b86a';
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.fillText('VIVA MODE · PRIVATE', pad, 84);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = '#f2f6f8';
  ctx.font = '700 52px system-ui, sans-serif';
  ctx.fillText('Calm Report', pad, 148);

  const when = new Date(record.startedAt);
  ctx.fillStyle = '#9aa9b0';
  ctx.font = '400 19px system-ui, sans-serif';
  ctx.fillText(
    `${when.toLocaleDateString()} · ${fmtDuration(record.endedAt - record.startedAt)} · ${
      record.questions.length
    } questions`,
    pad,
    184,
  );

  // headline strip
  ctx.fillStyle = 'rgba(232,184,106,0.12)';
  roundRect(ctx, pad, 214, W - pad * 2, 58, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(232,184,106,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const insight = summarise(record);
  const line = insight.calmest
    ? `Calmest answer: ${insight.calmest.topic} (${fmtPct(insight.calmest.pulseDeltaPct)} vs your baseline)`
    : 'No vitals recorded for this session';
  ctx.fillStyle = '#f4e3c4';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillText(line, pad + 22, 251);

  // question rows
  let y = top;
  record.questions.forEach((q, i) => {
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    roundRect(ctx, pad, y, W - pad * 2, rowH - 14, 12);
    ctx.fill();

    ctx.fillStyle = '#8fa1aa';
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillText(`Q${i + 1}`, pad + 20, y + 30);

    ctx.fillStyle = '#eef4f6';
    ctx.font = '650 21px system-ui, sans-serif';
    ctx.fillText(q.topic.slice(0, 52), pad + 68, y + 32);

    ctx.fillStyle = '#8fa1aa';
    ctx.font = '400 15px system-ui, sans-serif';
    ctx.fillText(`${q.subject} · ${q.module}`, pad + 68, y + 56);

    // pulse delta bar
    const barX = W - pad - 300;
    const barW = 180;
    const delta = q.pulseDeltaPct ?? 0;
    const frac = Math.max(-1, Math.min(1, delta / 30));
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(ctx, barX, y + 28, barW, 10, 5);
    ctx.fill();
    ctx.fillStyle = delta > 10 ? '#e8836f' : delta > 3 ? '#e0a35e' : '#7fc6a8';
    const w = Math.abs(frac) * (barW / 2);
    roundRect(ctx, barX + barW / 2 - (frac < 0 ? w : 0), y + 28, Math.max(3, w), 10, 5);
    ctx.fill();

    ctx.fillStyle = '#c8d3d8';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtPct(q.pulseDeltaPct), W - pad - 20, y + 30);
    ctx.fillStyle = '#8fa1aa';
    ctx.font = '400 13px system-ui, sans-serif';
    ctx.fillText(
      `first word ${fmtDuration(q.answerLatencyMs)}${q.settled ? ' · settled' : ''}`,
      W - pad - 20,
      y + 54,
    );
    ctx.textAlign = 'left';

    y += rowH;
  });

  // footer
  ctx.fillStyle = '#7d8d96';
  ctx.font = '400 15px system-ui, sans-serif';
  ctx.fillText(
    'Wellness/practice tool. Not medical advice. SmartSpectra metrics are not FDA-cleared.',
    pad,
    H - 56,
  );
  ctx.fillStyle = '#5d6c75';
  ctx.font = '400 13px system-ui, sans-serif';
  ctx.fillText(
    `Generated locally by Viva Mode ${record.appVersion} · SmartSpectra ${record.sdkVersion}`,
    pad,
    H - 32,
  );

  return canvas.toDataURL('image/png');
}
