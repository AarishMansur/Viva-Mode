# Viva Mode — build plan

## Goal

Make a lab viva feel like a room you can settle into, not a timer you have to beat. The examiner
asks real VTU CSE questions; the room follows your breathing relative to your own baseline; the
session ends with a private Calm Report you can read or export.

The app must be honest about what it can read, honest about what it stores, and careful with its
language.

## Phases

| Phase | What happens |
| --- | --- |
| `consent` | Plain-language explanation, API key, telemetry choice, camera or practice |
| `calibrating` | 60 s of settling in; median pulse, breathing and HRV become the baseline |
| `ready` | The examiner is ready; the user asks for the first question |
| `think` | The question is on the card. Breathing drives the room; a pacer appears only when useful |
| `answer` | Talking detector (or the “I'll answer now” button) starts the answer; silence ends it |
| `between` | The answer is recorded; the user moves on when ready |
| `report` | Private Calm Report, saved locally |

Practice mode skips calibration and the answer-signal path entirely. It uses the same questions and
the same timing controls, but no camera, no vitals and no saved report.

## Thresholds

Every magic number lives in `T` in `src/shared/stateMachine.ts`.

| Constant | Value | Why |
| --- | --- | --- |
| `CALIBRATION_MIN_MS` | 60 000 | A minute of quiet is enough for a usable personal baseline |
| `CALIBRATION_MAX_MS` | 120 000 | After two minutes, offer practice without signals |
| `CALIBRATION_MIN_PULSE_SAMPLES` | 20 | Fewer than this is not a baseline |
| `CALIBRATION_EXTEND_MS` | 75 000 | When to explain that calibration is still waiting |
| `BREATH_TAU_S` | 10 | Smooth breathing without hiding a real change |
| `PULSE_TAU_S` | 6 | Pulse is faster than breathing; smooth it less |
| `BREATH_ELEVATED` | +15 % | Above this, the room starts to tighten |
| `BREATH_SETTLED` | +5 % | At or below this, the room can soften |
| `PULSE_ELEVATED` | +10 % | Fallback when breathing never became usable |
| `PULSE_SETTLED` | +3 % | Fallback settled band |
| `SETTLED_HOLD_MS` | 8 000 | The room only steps after eight seconds of settled breathing |
| `PACER_COOLDOWN_MS` | 20 000 | No pacer strobe |
| `MOOD_COOLDOWN_MS` | 6 000 | The examiner does not twitch |
| `CALM_RATE_PER_S` | 0.08 | Calm units per second |
| `CALM_MAX_STEP` | 0.08 | Per-tick clamp, so the room never snaps |
| `ROOM_NEUTRAL` | 0.5 | Where the room drifts when breathing is unreadable |
| `TALKING_ONSET_MS` | 1 200 | Talking for this long flips Think → Answer |
| `ANSWER_SILENCE_MS` | 4 000 | This much silence ends the answer |
| `ANSWER_MAX_MS` | 240 000 | A stuck detector cannot hang the session |
| `FRESH_MS` | 20 000 | Older samples are stale |
| `TIMELINE_MS` | 1 000 | One timeline point per second |
| `SPIKE_PCT` | 10 % | Descriptive only, never a diagnosis |

## Decisions

1. **The SDK's `metrics` event is windowed.** It carries the samples since the previous emit, not a
   cumulative list. The app takes the newest entry in each array and de-duplicates on the SDK's own
   timestamps.
2. **Breathing confidence comes from `breathing.rate[]`.** `upperTrace[]` has no `stable` or
   `confidence` fields; it is used only for the pacer's shape.
3. **Two clocks.** `performance.now()` drives the state machine and the UI. SDK epoch-microsecond
   timestamps drive the EMA `dt` and packet de-duplication.
4. **Pulse fallback only when breathing was never calibrated.** If breathing was calibrated and then
   goes stale, the room drifts to `ROOM_NEUTRAL`; it does not infer calm from pulse.
5. **Fixed five questions per viva.** Round-robin across subjects so a session is never five OS
   questions in a row.
6. **No network model.** The examiner's remark is computed locally by `remarkFor`; nothing is sent
   anywhere.
7. **A mutating reducer.** `step()` mutates and returns the state. That keeps the 30 Hz render loop
   allocation-free and keeps the tests deterministic.
8. **Sandboxed preload.** The preload is bundled by esbuild because a sandboxed preload cannot
   `require` from `node_modules`.
9. **The key never ships.** It comes from settings (`safeStorage`), `PRESAGE_API_KEY`, or the consent
   screen; it is never baked into the bundle.

## Data handling

- Frames stay in the SDK's native engine; no frame or landmark is written to disk.
- Sessions contain per-question summaries only, not raw signals.
- Settings, sessions and the encrypted key live in the app's data folder.
- Telemetry is opt-in and aggregate only.
- **Delete all my data** removes everything the app wrote.

## Report copy

- Always relative to the user's own baseline.
- A pulse rise is described as “higher than your baseline”, never as stress or anxiety.
- HRV is a direction, not a score to compare with other people.
- The footer says the tool is not a medical device and the metrics are not FDA-cleared.

## Testing

- `test/stateMachine.test.ts` covers calibration, breathing hysteresis, pulse fallback, talking
  transitions, the pacer cooldown, mood changes and the report summary.
- `npm run smoke` drives the real Electron app through consent → practice → five questions → report
  → settings, asserts the DOM, and writes screenshots plus `smoke/result.json`.
- `npm run typecheck` keeps the shared model honest.

## Out of scope

- Diagnosis, treatment, or any clinical claim.
- Cloud accounts, sync, or a leaderboard.
- Covert monitoring. The camera is visible, explained, and can be stopped at any time.
- An LLM in the loop. The report is deterministic and local.
