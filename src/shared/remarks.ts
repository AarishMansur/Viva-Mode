// src/shared/remarks.ts
// The local "examiner's remark" — one line per answered question.
//
// Deliberately computed here, from the numbers on this laptop. No model, no
// network, nothing sent to Presage. The point is a nudge you can act on.
//
// Copy rules (checked by test/stateMachine.test.ts): always relative to your
// own baseline, never clinical.

import type { QuestionResult } from './types.ts';
import { fmtDuration } from './format.ts';

export function remarkFor(q: QuestionResult): string {
  const d = q.pulseDeltaPct;
  if (q.pacerShown && q.settled) {
    return `You caught it and settled back in ${fmtDuration(q.recoveryMs)}. That recovery is the skill.`;
  }
  if (q.settled) {
    return 'You stayed inside your own baseline band the whole way through.';
  }
  if (d != null && d > 20) {
    return 'Your pulse ran higher here than anywhere else this session. Worth a second pass out loud.';
  }
  if (d != null && d > 10) {
    return 'A little higher than your baseline — not a problem, just a note for next time.';
  }
  if (q.answerLatencyMs != null && q.answerLatencyMs > 12_000) {
    return 'You took your time before the first word. That pause is allowed.';
  }
  return 'You got through it. Nothing here needs fixing.';
}
