/**
 * Periodic managed-usage fetcher for the footer's `usage` status-line slot.
 *
 * Calls the same platform endpoint as `/usage` and publishes the latest
 * snapshot into AppState so the footer can render the 5h / weekly quota
 * badge and hand the rows to the user's status line command.
 *
 * Polling only runs while the current model belongs to a managed provider
 * (Kimi) and some consumer is active — the `usage` slot being visible, or a
 * configured status line command. Failures keep the previous snapshot;
 * unchanged snapshots are not re-published.
 */

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { isManagedUsageProvider } from '../constant/kimi-tui';
import type { AppState, ManagedUsageSnapshot } from '../types';

const TICK_INTERVAL_MS = 15_000;
const FETCH_INTERVAL_MS = 60_000;

export interface ManagedUsagePollerOptions {
  readonly harness: KimiHarness;
  readonly getState: () => AppState;
  readonly onUpdate: (snapshot: ManagedUsageSnapshot) => void;
}

export interface ManagedUsagePoller {
  dispose(): void;
}

export function createManagedUsagePoller(
  options: ManagedUsagePollerOptions,
): ManagedUsagePoller {
  let inFlight = false;
  let lastFetchedAt = 0;
  let lastProviderKey: string | null = null;
  let lastPublishedJson = '';
  let disposed = false;

  async function refresh(): Promise<void> {
    const state = options.getState();
    // Only poll when there is a consumer: the built-in `usage` slot is in
    // the configured items (or default items include it), or a custom
    // status line command is set.
    const items = state.statusLine?.items;
    const hasUsageSlot =
      items === null || items === undefined
        ? // Default items include `usage` when we add it below; check via
          // the shared constant would create a circular dep, so just
          // assume default layout shows usage.
          true
        : items.includes('usage');
    const hasCustomCommand =
      state.statusLine?.command !== null && state.statusLine?.command !== undefined;
    if (!hasUsageSlot && !hasCustomCommand) return;

    const providerKey = state.availableModels[state.model]?.provider;
    if (!isManagedUsageProvider(providerKey)) return;

    const now = Date.now();
    if (providerKey === lastProviderKey && now - lastFetchedAt < FETCH_INTERVAL_MS) return;
    if (inFlight) return;

    inFlight = true;
    lastProviderKey = providerKey;
    try {
      const res = await options.harness.auth.getManagedUsage(providerKey);
      lastFetchedAt = Date.now();
      if (disposed || res.kind === 'error') return;

      const snapshot: ManagedUsageSnapshot = {
        summary:
          res.summary !== null && res.summary !== undefined
            ? {
                label: res.summary.name ?? '5h',
                used: res.summary.used,
                limit: res.summary.limit,
                resetHint: res.summary.resetAt,
              }
            : null,
        limits: res.limits.map((row) => ({
          label: row.name ?? '',
          used: row.used,
          limit: row.limit,
          resetHint: row.resetAt,
        })),
        fetchedAt: lastFetchedAt,
      };

      // Dedupe on the quota content only — `fetchedAt` changes every fetch.
      const json = JSON.stringify({ summary: snapshot.summary, limits: snapshot.limits });
      if (json === lastPublishedJson) return;
      lastPublishedJson = json;
      options.onUpdate(snapshot);
    } catch {
      // Keep the previous snapshot on failure.
    } finally {
      inFlight = false;
    }
  }

  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, TICK_INTERVAL_MS);
  timer.unref?.();

  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
