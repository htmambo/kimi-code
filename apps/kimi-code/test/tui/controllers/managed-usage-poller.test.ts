import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import {
  createManagedUsagePoller,
  type ManagedUsagePoller,
} from '#/tui/controllers/managed-usage-poller';
import type { AppState, ManagedUsageSnapshot } from '#/tui/types';

const MANAGED_PROVIDER = DEFAULT_OAUTH_PROVIDER_NAME;
const FUTURE_RESET = '2099-01-01T00:00:00.000Z';

function makeState(provider: string | undefined = MANAGED_PROVIDER): AppState {
  return {
    model: 'kimi-k2',
    availableModels:
      provider === undefined ? {} : { 'kimi-k2': { provider } as AppState['availableModels'][string] },
  } as AppState;
}

function makeUsageResult(used = 10, withReset = true) {
  const row = {
    window: { duration: 5, unit: 'hour' as const },
    used,
    limit: 100,
    resetAt: withReset ? FUTURE_RESET : undefined,
  };
  return {
    kind: 'ok' as const,
    summary: {
      window: { duration: 1, unit: 'week' as const },
      used: used * 4,
      limit: 100,
      resetAt: withReset ? FUTURE_RESET : undefined,
    },
    limits: [row],
    extraUsage: null,
  };
}

interface Fixture {
  readonly poller: ManagedUsagePoller;
  readonly getManagedUsage: ReturnType<typeof vi.fn>;
  readonly updates: (ManagedUsageSnapshot | null)[];
  readonly state: AppState;
}

function createFixture(
  provider: string | undefined = MANAGED_PROVIDER,
  result: ReturnType<typeof makeUsageResult> = makeUsageResult(),
): Fixture {
  const state = makeState(provider);
  const getManagedUsage = vi.fn().mockResolvedValue(result);
  const harness = { auth: { getManagedUsage } } as unknown as KimiHarness;
  const updates: (ManagedUsageSnapshot | null)[] = [];
  const poller = createManagedUsagePoller({
    harness,
    getState: () => state,
    onUpdate: (snapshot) => updates.push(snapshot),
  });
  return { poller, getManagedUsage, updates, state };
}

describe('managed-usage-poller', () => {
  let fixture: Fixture;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    fixture.poller.dispose();
    vi.useRealTimers();
  });

  it('publishes a labelled snapshot for managed providers on start', async () => {
    fixture = createFixture();
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.getManagedUsage).toHaveBeenCalledWith(MANAGED_PROVIDER);
    expect(fixture.updates).toHaveLength(1);
    const snapshot = fixture.updates[0]!;
    expect(snapshot?.summary?.label).toBe('Weekly limit');
    expect(snapshot?.limits[0]?.label).toBe('5h limit');
    expect(snapshot?.limits[0]?.resetHint).toMatch(/^resets in /);
  });

  it('throttles refetches to one per fetch interval', async () => {
    fixture = createFixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(2);
  });

  it('dedupes unchanged snapshots', async () => {
    // No resetAt: the reset hint is clock-derived and would change on every
    // fetch, defeating content dedupe by design.
    fixture = createFixture(MANAGED_PROVIDER, makeUsageResult(10, false));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(2);
    expect(fixture.updates).toHaveLength(1);
  });

  it.each([
    ['an API error result', { kind: 'error' as const, message: 'boom' }],
    ['a network exception', new Error('offline')],
  ])('throttles retries to the fetch interval after %s', async (_label, failure) => {
    fixture = createFixture();
    await vi.advanceTimersByTimeAsync(0);
    if (failure instanceof Error) {
      fixture.getManagedUsage.mockRejectedValueOnce(failure);
    } else {
      fixture.getManagedUsage.mockResolvedValueOnce(failure);
    }

    await vi.advanceTimersByTimeAsync(60_000); // the failing fetch
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000); // within the throttle window
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(3);
  });

  it('publishes null when the provider switches to non-managed', async () => {
    fixture = createFixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.updates).toHaveLength(1);

    fixture.state.availableModels = {};
    fixture.poller.refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.updates).toEqual([expect.objectContaining({ fetchedAt: expect.any(Number) }), null]);
  });

  it('refreshNow bypasses the fetch-interval throttle', async () => {
    fixture = createFixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(1);

    fixture.getManagedUsage.mockResolvedValueOnce(makeUsageResult(20));
    fixture.poller.refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(2);
    expect(fixture.updates).toHaveLength(2);
  });

  it('does not fetch at all for non-managed providers', async () => {
    fixture = createFixture('other-provider');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fixture.getManagedUsage).not.toHaveBeenCalled();
    expect(fixture.updates).toHaveLength(0);
  });

  it('stops polling after dispose', async () => {
    fixture = createFixture();
    await vi.advanceTimersByTimeAsync(0);
    fixture.poller.dispose();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.getManagedUsage).toHaveBeenCalledTimes(1);
  });
});
