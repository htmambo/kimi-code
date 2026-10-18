import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedQuotaUsages } from '@moonshot-ai/kimi-code-oauth';

import {
  createManagedUsagePoller,
  type ManagedUsagePollerOptions,
} from '#/tui/controllers/managed-usage-poller';
import type { AppState, ManagedUsageSnapshot } from '#/tui/types';

type Harness = ManagedUsagePollerOptions['harness'];
type GetManagedUsage = Harness['auth']['getManagedUsage'];
type WireResult = Awaited<ReturnType<GetManagedUsage>>;

function wireOk(usages: ManagedQuotaUsages): WireResult {
  return {
    kind: 'ok',
    quota: { usages, extraUsage: null },
  } as never;
}

function wireError(message = 'boom'): WireResult {
  return { kind: 'error', message } as never;
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    version: '1.0.0',
    workDir: '/tmp',
    additionalDirs: [],
    sessionId: 's1',
    sessionTitle: null,
    model: 'kimi-k2',
    permissionMode: 'manual',
    planMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    theme: 'dark',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {
      'kimi-k2': { provider: 'managed:kimi-code', model: 'kimi-k2', maxContextSize: 262144 },
      'external-model': { provider: 'external:openai', model: 'external-model', maxContextSize: 8192 },
    },
    availableProviders: {},
    mcpServersSummary: null,
    ...overrides,
  };
}

function createHarness(getManagedUsage: ReturnType<typeof vi.fn>): Harness {
  return { auth: { getManagedUsage } } as never;
}

function lastSnapshot(updates: Array<ManagedUsageSnapshot | null>): ManagedUsageSnapshot | null {
  return updates.at(-1) ?? null;
}

async function tick(): Promise<void> {
  // Advance fake time without scheduling any timers — this drains pending
  // microtasks so the in-flight fetch's promise chain resolves.
  await vi.advanceTimersByTimeAsync(0);
}

describe('ManagedUsagePoller', () => {
  let getManagedUsage: ReturnType<typeof vi.fn>;
  let state: AppState;
  let updates: Array<ManagedUsageSnapshot | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    getManagedUsage = vi.fn();
    state = makeState();
    updates = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startPoller(overrides: Partial<ManagedUsagePollerOptions> = {}) {
    const poller = createManagedUsagePoller({
      harness: createHarness(getManagedUsage),
      getState: () => state,
      onUpdate: (snapshot) => updates.push(snapshot),
      ...overrides,
    });
    return poller;
  }

  it('publishes the first snapshot for a managed provider', async () => {
    getManagedUsage.mockResolvedValue(wireOk({ limit5h: { usedRatio: 0.3 } }));
    const poller = startPoller();
    await tick();
    poller.dispose();

    const snap = lastSnapshot(updates) as ManagedUsageSnapshot;
    expect(snap).not.toBeNull();
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]?.label).toBe('5h limit');
    expect(snap.rows[0]?.usedRatio).toBe(0.3);
    expect(getManagedUsage).toHaveBeenCalledTimes(1);
    expect(getManagedUsage).toHaveBeenCalledWith('managed:kimi-code');
  });

  it('drops any published snapshot when the provider stops being managed', async () => {
    getManagedUsage.mockResolvedValueOnce(wireOk({ limit5h: { usedRatio: 0.1 } }));
    const poller = startPoller();
    await tick();
    expect(lastSnapshot(updates)).not.toBeNull();

    state = makeState({ model: 'external-model' });
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(lastSnapshot(updates)).toBeNull();
  });

  it('refetches immediately after switching back from a non-managed provider', async () => {
    state = makeState({ model: 'external-model' });
    getManagedUsage.mockResolvedValue(wireOk({ limit5h: { usedRatio: 0.01 } }));
    const poller = startPoller();
    await tick();
    expect(getManagedUsage).not.toHaveBeenCalled();

    state = makeState({ model: 'kimi-k2' });
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(getManagedUsage).toHaveBeenCalledTimes(1);
    expect(lastSnapshot(updates)).not.toBeNull();
  });

  it('does not republish a snapshot with identical quota content', async () => {
    getManagedUsage.mockResolvedValue(wireOk({ limit5h: { usedRatio: 0.3 } }));
    const poller = startPoller();
    await tick();

    const before = updates.length;
    // Wait past the throttle so the next interval tick will fetch again.
    await vi.advanceTimersByTimeAsync(70_000);
    poller.dispose();

    expect(getManagedUsage.mock.calls.length).toBeGreaterThan(1);
    expect(updates.length).toBe(before); // identical snapshot suppressed
  });

  it('keeps the previous snapshot when a fetch returns an error', async () => {
    getManagedUsage.mockResolvedValueOnce(wireOk({ limit5h: { usedRatio: 0.3 } }));
    const poller = startPoller();
    await tick();
    const before = lastSnapshot(updates);

    getManagedUsage.mockResolvedValueOnce(wireError('server down'));
    await vi.advanceTimersByTimeAsync(70_000);
    poller.dispose();

    expect(lastSnapshot(updates)).toBe(before);
  });

  it('discards an in-flight response when a newer refresh supersedes it', async () => {
    let resolveFirst!: (value: WireResult) => void;
    const firstResponse = new Promise<WireResult>((res) => {
      resolveFirst = res;
    });
    getManagedUsage.mockReturnValueOnce(firstResponse);

    const poller = startPoller();
    await tick();

    // Provider switches mid-flight (e.g. user picks another managed model).
    state = makeState({ model: 'external-model' });
    poller.refreshNow();
    await tick();

    // The in-flight managed response lands — must NOT republish into the
    // now non-managed state.
    resolveFirst(wireOk({ limit5h: { usedRatio: 0.99 } }));
    await tick();
    poller.dispose();

    expect(lastSnapshot(updates)).toBeNull();
  });

  it('lets refreshNow() bypass the throttle without waiting for the interval', async () => {
    getManagedUsage.mockResolvedValue(wireOk({ limit5h: { usedRatio: 0.01 } }));
    const poller = startPoller();
    await tick();
    const initialCalls = getManagedUsage.mock.calls.length;

    // Way before the 60s interval; without refreshNow() the next fetch would
    // be skipped.
    await vi.advanceTimersByTimeAsync(5_000);
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(getManagedUsage.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('does not publish after dispose', async () => {
    getManagedUsage.mockResolvedValue(wireOk({ limit5h: { usedRatio: 0.01 } }));
    const poller = startPoller();
    await tick();
    const before = updates.length;
    poller.dispose();

    await vi.advanceTimersByTimeAsync(70_000);

    expect(updates.length).toBe(before);
  });

  it('labels the weekly and monthly quota entries', async () => {
    getManagedUsage.mockResolvedValue(
      wireOk({
        limit5h: { usedRatio: 0.1 },
        limit7d: { usedRatio: 0.5 },
        monthTotal: { usedRatio: 0.2 },
      }),
    );
    const poller = startPoller();
    await tick();
    poller.dispose();

    const snap = lastSnapshot(updates) as ManagedUsageSnapshot;
    expect(snap.rows.map((row) => row.label)).toEqual(['5h limit', 'Weekly limit', 'Monthly limit']);
  });

  it('carries the reset hint from the quota entry', async () => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    getManagedUsage.mockResolvedValue(
      wireOk({ limit5h: { usedRatio: 0.1, resetAt: '2026-09-15T14:30:00Z' } }),
    );
    const poller = startPoller();
    await tick();
    poller.dispose();

    const snap = lastSnapshot(updates) as ManagedUsageSnapshot;
    expect(snap.rows[0]?.resetHint).toBe('resets in 2h 30m');
  });

  it('keeps the snapshot while the current model is not yet resolved in the model list', async () => {
    getManagedUsage.mockResolvedValueOnce(wireOk({ limit5h: { usedRatio: 0.1 } }));
    const poller = startPoller();
    await tick();
    const before = lastSnapshot(updates);
    expect(before).not.toBeNull();

    // Model-list refresh in flight: the current model is momentarily absent.
    state = makeState({ availableModels: {} });
    poller.refreshNow();
    await tick();

    // The list resolves again: the next refresh must refetch immediately
    // instead of waiting out the fetch interval.
    state = makeState();
    getManagedUsage.mockResolvedValueOnce(wireOk({ limit5h: { usedRatio: 0.2 } }));
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(updates).toHaveLength(2);
    expect(updates[0]).toBe(before);
    expect(updates[1]?.rows[0]?.usedRatio).toBe(0.2);
  });

  it('does not fetch while the current model is unresolved, even at startup', async () => {
    state = makeState({ availableModels: {} });
    const poller = startPoller();
    await tick();
    expect(getManagedUsage).not.toHaveBeenCalled();

    state = makeState();
    getManagedUsage.mockResolvedValueOnce(wireOk({ limit5h: { usedRatio: 0.4 } }));
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(lastSnapshot(updates)?.rows[0]?.usedRatio).toBe(0.4);
  });

  it('keeps the previous snapshot when a response carries no quota rows', async () => {
    getManagedUsage.mockResolvedValueOnce(wireOk({ limit5h: { usedRatio: 0.3 } }));
    const poller = startPoller();
    await tick();
    const before = lastSnapshot(updates);
    expect(before).not.toBeNull();

    getManagedUsage.mockResolvedValueOnce(wireOk({}));
    await vi.advanceTimersByTimeAsync(70_000);
    poller.dispose();

    expect(getManagedUsage).toHaveBeenCalledTimes(2);
    expect(lastSnapshot(updates)).toBe(before);
  });

  it('does not publish when the backend serves no quota entries', async () => {
    getManagedUsage.mockResolvedValue(wireOk({}));
    const poller = startPoller();
    await tick();
    poller.dispose();

    expect(lastSnapshot(updates)).toBeNull();
  });
});