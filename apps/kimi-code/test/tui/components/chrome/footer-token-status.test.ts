import { describe, expect, it } from 'vitest';

import { formatTokenStatus } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';

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

describe('formatTokenStatus', () => {
  it('returns undefined when there is no token data and no step timing', () => {
    expect(formatTokenStatus(makeState(), 200)).toBeUndefined();
  });

  it('returns undefined when maxWidth is zero or negative', () => {
    const state = makeState({
      cumulativeInputTokens: 12_345,
      cumulativeOutputTokens: 2_345,
      stepTiming: { outputTokens: 100, streamMs: 1000, tps: 100 },
    });
    expect(formatTokenStatus(state, 0)).toBeUndefined();
    expect(formatTokenStatus(state, -5)).toBeUndefined();
  });

  it('renders speed alone when no cumulative tokens exist yet', () => {
    const state = makeState({
      stepTiming: { outputTokens: 200, streamMs: 1000, tps: 200 },
    });
    expect(formatTokenStatus(state, 200)).toBe('200 tok/s');
  });

  it('uses one decimal for sub-100 rates, integer for >=100', () => {
    const sub = makeState({
      stepTiming: { outputTokens: 50, streamMs: 1000, tps: 50 },
    });
    const sup = makeState({
      stepTiming: { outputTokens: 250, streamMs: 1000, tps: 250 },
    });
    expect(formatTokenStatus(sub, 200)).toBe('50.0 tok/s');
    expect(formatTokenStatus(sup, 200)).toBe('250 tok/s');
  });

  it('renders IN and OUT together when both have values', () => {
    const state = makeState({
      cumulativeInputTokens: 12_288,
      cumulativeOutputTokens: 2_304,
    });
    expect(formatTokenStatus(state, 200)).toBe('↓12k ↑2.3k');
  });

  it('omits a side when only IN or only OUT has tokens', () => {
    const onlyIn = makeState({ cumulativeInputTokens: 12_288 });
    expect(formatTokenStatus(onlyIn, 200)).toBe('↓12k');

    const onlyOut = makeState({ cumulativeOutputTokens: 2_304 });
    expect(formatTokenStatus(onlyOut, 200)).toBe('↑2.3k');
  });

  it('hides zero-value IN/OUT/CR/CW fields', () => {
    const state = makeState({
      cumulativeInputTokens: 12_288,
      cumulativeOutputTokens: 0,
      cumulativeCacheReadTokens: 0,
      cumulativeCacheCreationTokens: 0,
    });
    expect(formatTokenStatus(state, 200)).toBe('↓12k');
  });

  it('renders cache fields with CR/CW symbols and a hit percent', () => {
    const state = makeState({
      cumulativeInputTokens: 1_000,
      cumulativeCacheReadTokens: 9_000,
      cumulativeCacheCreationTokens: 0,
    });
    // hit = 9000 / (1000 + 9000 + 0) = 90%
    expect(formatTokenStatus(state, 200)).toBe('↓1000 · ↻8.8k · hit 90%');
  });

  it('omits hit when no cache read happened', () => {
    const state = makeState({
      cumulativeInputTokens: 12_288,
      cumulativeCacheCreationTokens: 5_120,
    });
    expect(formatTokenStatus(state, 200)).toBe('↓12k · +5k');
  });

  it('treats zero-valued cumulative fields as "no data" (hide them)', () => {
    const state = makeState({
      cumulativeInputTokens: 12_288,
      cumulativeCacheReadTokens: 0,
      cumulativeCacheCreationTokens: 0,
    });
    expect(formatTokenStatus(state, 200)).toBe('↓12k');
  });

  it('progressive truncation drops hit first, then CR/CW, then IN/OUT, then hides', () => {
    const state = makeState({
      stepTiming: { outputTokens: 200, streamMs: 1000, tps: 200 },
      cumulativeInputTokens: 12_288,
      cumulativeOutputTokens: 2_048,
      cumulativeCacheReadTokens: 9_216,
      cumulativeCacheCreationTokens: 1_024,
    });
    // Full: "200 tok/s · ↓12k ↑2k · ↻9k +1k · hit 75%"
    //   hit = 9216 / (12288 + 9216 + 1024) = 9216 / 22528 ≈ 41%
    expect(formatTokenStatus(state, 200)).toBe(
      '200 tok/s · ↓12k ↑2k · ↻9k +1k · hit 41%',
    );
    // Drop hit
    expect(formatTokenStatus(state, 39)).toBe('200 tok/s · ↓12k ↑2k · ↻9k +1k');
    // Drop CR/CW (keep speed + IN/OUT)
    expect(formatTokenStatus(state, 25)).toBe('200 tok/s · ↓12k ↑2k');
    // Drop IN/OUT (keep only speed)
    expect(formatTokenStatus(state, 10)).toBe('200 tok/s');
    // Even speed doesn't fit → undefined
    expect(formatTokenStatus(state, 5)).toBeUndefined();
  });

  it('renders single-element groups with no inline separator', () => {
    const state = makeState({
      cumulativeInputTokens: 100,
      cumulativeCacheReadTokens: 900,
    });
    // 900 / (100 + 900) = 90%
    expect(formatTokenStatus(state, 200)).toBe('↓100 · ↻900 · hit 90%');
  });
});