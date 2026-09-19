import type { AppState } from '#/tui/types';
import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

/**
 * Build the AppState patch for cumulative-token fields from a session-wide
 * `usage.total` payload.
 *
 * - When `total` is `undefined` (no payload yet, or session/replay reset):
 *   all five cumulative fields are zeroed and `stepTiming` is cleared, so
 *   values from a previous session cannot bleed into the new session's
 *   footer rendering.
 * - When `total` is present: only the cumulative fields are updated.
 *   `stepTiming` is intentionally left untouched — it is owned by the
 *   `StepCompleted` event handler and must persist between status reports
 *   so the displayed TPS does not flicker on every status tick.
 *
 * On the undefined branch we return the literal 0 directly.
 */
export function cumulativeUsagePatch(total: TokenUsage | undefined): Partial<AppState> {
  if (total === undefined) {
    return {
      cumulativeTokens: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCacheReadTokens: 0,
      cumulativeCacheCreationTokens: 0,
      stepTiming: undefined,
    };
  }
  // Normalize once so the sum cannot produce NaN when an individual
  // field is missing. The wire schema marks all four required numbers, but
  // defensive normalization here keeps the math safe under partial payloads.
  const inputOther = total.inputOther ?? 0;
  const output = total.output ?? 0;
  const cacheRead = total.inputCacheRead ?? 0;
  const cacheCreation = total.inputCacheCreation ?? 0;
  return {
    cumulativeTokens: inputOther + output + cacheRead + cacheCreation,
    cumulativeInputTokens: inputOther,
    cumulativeOutputTokens: output,
    cumulativeCacheReadTokens: cacheRead,
    cumulativeCacheCreationTokens: cacheCreation,
  };
}