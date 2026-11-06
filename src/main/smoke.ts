// src/main/smoke.ts
// A camera-free end-to-end check of the renderer, driven by the main process.
//
// Enabled only with VIVA_SMOKE=1 (see `npm run smoke`). It opens the window,
// walks the whole practice flow by clicking the real buttons, asserts on the
// real DOM, writes screenshots to ./smoke, and exits with 0 or 1.
//
// This never touches the SDK or the network: practice mode is deliberately the
// path that needs no API key.

import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface Probe {
  screen: string;
  bridge: boolean;
  sdkBridge: boolean;
  version: string;
  question: string;
  phase: string;
  stamp: string;
  calm: string;
  hint: string;
  askHidden: boolean;
  questionCards: number;
  headline: string;
  stats: number;
  errors: string[];
}

async function probe(win: BrowserWindow): Promise<Probe> {
  return win.webContents.executeJavaScript(`(() => {
    const $ = (s) => document.querySelector(s);
    const text = (s) => (($(s) || {}).textContent || '').trim();
    const screens = ['screen-consent', 'screen-room', 'screen-report', 'screen-settings'];
    const active = screens.find((id) => {
      const n = document.getElementById(id);
      return !!n && n.classList.contains('is-active');
    });
    return {
      screen: active || 'none',
      bridge: typeof window.viva === 'object',
      sdkBridge: typeof window.__smartspectraBridge === 'object',
      version: text('#consent-version'),
      question: text('#q-question'),
      phase: text('#q-phase'),
      stamp: text('#q-stamp'),
      calm: getComputedStyle(document.documentElement).getPropertyValue('--calm').trim(),
      hint: text('#hud-hint'),
      askHidden: !!$('#btn-ask') && $('#btn-ask').hidden,
      questionCards: document.querySelectorAll('#report-questions .qres').length,
      headline: text('#report-headline'),
      stats: document.querySelectorAll('#report-stats > div').length,
      errors: (window.__smokeErrors || []).slice(0, 5),
    };
  })()`);
}

async function click(win: BrowserWindow, id: string): Promise<void> {
  await win.webContents.executeJavaScript(
    `(() => {
      const n = document.getElementById(${JSON.stringify(id)});
      if (!n) throw new Error('missing #' + ${JSON.stringify(id)});
      n.click();
      return true;
    })()`,
    true,
  );
}

async function shot(win: BrowserWindow, dir: string, name: string): Promise<void> {
  const image = await win.webContents.capturePage();
  await fs.writeFile(path.join(dir, `${name}.png`), image.toPNG());
}

export async function runSmoke(win: BrowserWindow): Promise<void> {
  const outDir = path.join(app.getAppPath(), 'smoke');
  await fs.mkdir(outDir, { recursive: true });

  const errors: string[] = [];
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: string | number; message?: string } | undefined;
    const level = typeof args[1] === 'number' ? args[1] : first?.level;
    const message = typeof args[2] === 'string' ? args[2] : first?.message;
    if (level === 3 || level === 'error') errors.push(String(message ?? 'unknown console error'));
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push(`renderer process gone: ${details.reason}`);
  });

  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
  };

  try {
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) =>
        win.webContents.once('did-finish-load', () => resolve()),
      );
    }
    await wait(1200);
    await win.webContents.executeJavaScript(`(() => {
      window.__smokeErrors = [];
      window.addEventListener('error', (e) => window.__smokeErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__smokeErrors.push('unhandled: ' + String(e.reason)));
      return true;
    })()`);

    // --- consent ------------------------------------------------------------
    let p = await probe(win);
    check('consent screen is active', p.screen === 'screen-consent', p.screen);
    check('window.viva bridge is exposed', p.bridge);
    check('SmartSpectra preload bridge is exposed', p.sdkBridge);
    check('consent shows app + SDK versions', /3\.\d+\.\d+/.test(p.version), p.version);
    await shot(win, outDir, '1-consent');

    // --- practice mode (no camera, no key) ----------------------------------
    await click(win, 'btn-practice');
    await wait(900);
    p = await probe(win);
    check('practice mode opens the room', p.screen === 'screen-room', p.screen);
    check('practice mode is labelled as such', /practice mode/i.test(p.hint), p.hint);

    await click(win, 'btn-ask');
    await wait(500);
    p = await probe(win);
    check('a question is on the card', p.question.length > 15, p.question.slice(0, 60));
    check(
      'the room is in the think phase',
      /think/i.test(p.phase),
      `${p.phase} | stamp ${p.stamp} | ask hidden ${p.askHidden} | ${p.errors.join('; ')}`,
    );

    // --- answer, then walk the deck ----------------------------------------
    await click(win, 'btn-answer-now');
    await wait(400);
    p = await probe(win);
    check('manual answer control enters the answer phase', /answer/i.test(p.phase), p.phase);

    await click(win, 'btn-done-answering');
    await wait(400);
    await click(win, 'btn-next');
    await wait(500);
    await shot(win, outDir, '2-room');

    // Four more questions, then the report.
    for (let i = 1; i < 5; i++) {
      await click(win, 'btn-answer-now');
      await wait(250);
      await click(win, 'btn-done-answering');
      await wait(250);
      await click(win, 'btn-next');
      await wait(350);
    }

    p = await probe(win);
    check('the fifth answer ends in the Calm Report', p.screen === 'screen-report', p.screen);
    check('the report has one card per question', p.questionCards === 5, String(p.questionCards));
    check('the report headline is written', p.headline.length > 10, p.headline.slice(0, 70));
    check('the report stats rendered', p.stats >= 4, String(p.stats));
    await wait(500);
    await shot(win, outDir, '3-report');

    // --- settings -----------------------------------------------------------
    await click(win, 'btn-settings');
    await wait(400);
    p = await probe(win);
    check('settings opens over the report', p.screen === 'screen-settings', p.screen);
    await shot(win, outDir, '4-settings');
    await click(win, 'btn-settings-close');
    await wait(300);
    p = await probe(win);
    check('settings closes back to the report', p.screen === 'screen-report', p.screen);

    // --- calm variable ------------------------------------------------------
    check('--calm stays within 0..1', Number(p.calm) >= 0 && Number(p.calm) <= 1, p.calm);
  } catch (err) {
    check('smoke script ran without throwing', false, (err as Error).message);
  }

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = checks.filter((c) => !c.ok);
  const summary = {
    ok: failed.length === 0,
    checks,
    consoleErrors: errors,
    screenshots: outDir,
  };
  await fs.writeFile(path.join(outDir, 'result.json'), JSON.stringify(summary, null, 2));

  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  console.log(
    failed.length === 0
      ? `[smoke] all ${checks.length} checks passed — screenshots in ${outDir}`
      : `[smoke] ${failed.length} of ${checks.length} checks failed`,
  );

  app.exit(failed.length === 0 ? 0 : 1);
}
