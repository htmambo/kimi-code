import { describe, expect, it } from 'vitest';

import { cumulativeUsagePatch } from '#/tui/utils/usage-patch';
import { formatTokenStatus } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';
import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cumulativeTokens: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeCacheCreationTokens: 0,
    isCompacting: false,
    ...overrides,
  } as AppState;
}

describe('cumulativeUsagePatch', () => {
  it('zeros all cumulative fields and clears stepTiming when total is undefined', () => {
    const patch = cumulativeUsagePatch(undefined);
    expect(patch).toEqual({
      cumulativeTokens: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCacheReadTokens: 0,
      cumulativeCacheCreationTokens: 0,
      stepTiming: undefined,
    });
  });

  it('reset patch wipes previous-session bleed-through from a dirty state', () => {
    // Simulate the residue from a previous session that we must erase.
    const dirtyState = makeState({
      cumulativeTokens: 12_345,
      cumulativeInputTokens: 9_876,
      cumulativeOutputTokens: 2_345,
      cumulativeCacheReadTokens: 100,
      cumulativeCacheCreationTokens: 24,
      stepTiming: { outputTokens: 200, streamMs: 1000, tps: 200 },
    });
    // Verify the dirty state would render token status before the reset.
    // 9876 / 1024 = 9.64 → "9.6k"
    expect(formatTokenStatus(dirtyState, 200)).toContain('↓9.6k');

    // Apply the reset patch on top of the dirty state (spread merge).
    const reset = { ...dirtyState, ...cumulativeUsagePatch(undefined) };

    // After reset: every cumulative field is 0, stepTiming is cleared.
    expect(reset.cumulativeTokens).toBe(0);
    expect(reset.cumulativeInputTokens).toBe(0);
    expect(reset.cumulativeOutputTokens).toBe(0);
    expect(reset.cumulativeCacheReadTokens).toBe(0);
    expect(reset.cumulativeCacheCreationTokens).toBe(0);
    expect(reset.stepTiming).toBeUndefined();

    // The footer renders nothing — no bleed-through.
    expect(formatTokenStatus(reset, 200)).toBeUndefined();
  });

  it('non-reset patch only updates the cumulative fields and preserves stepTiming', () => {
    const existing = makeState({
      stepTiming: { outputTokens: 200, streamMs: 1000, tps: 200 },
    });
    const total: TokenUsage = {
      inputOther: 1000,
      output: 2000,
      inputCacheRead: 3000,
      inputCacheCreation: 4000,
    };
    const patch = cumulativeUsagePatch(total);
    expect(patch).toEqual({
      cumulativeTokens: 10_000,
      cumulativeInputTokens: 1000,
      cumulativeOutputTokens: 2000,
      cumulativeCacheReadTokens: 3000,
      cumulativeCacheCreationTokens: 4000,
    });
    expect(patch).not.toHaveProperty('stepTiming');

    // Verify stepTiming survives the spread merge on a state update.
    const merged = { ...existing, ...patch };
    expect(merged.stepTiming).toEqual({ outputTokens: 200, streamMs: 1000, tps: 200 });
  });

  it('uses 0 fallback when individual TokenUsage fields are missing', () => {
    const partial = {
      inputOther: 100,
      output: 200,
      // inputCacheRead / inputCacheCreation omitted
    } as TokenUsage;
    const patch = cumulativeUsagePatch(partial);
    expect(patch.cumulativeTokens).toBe(300);
    expect(patch.cumulativeInputTokens).toBe(100);
    expect(patch.cumulativeOutputTokens).toBe(200);
    expect(patch.cumulativeCacheReadTokens).toBe(0);
    expect(patch.cumulativeCacheCreationTokens).toBe(0);
  });
});