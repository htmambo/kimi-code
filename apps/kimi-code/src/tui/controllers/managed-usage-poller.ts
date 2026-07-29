/**
 * Periodic managed-usage fetcher for the footer's quota progress bars.
 *
 * Calls the same platform endpoint as `/usage` and publishes the latest
 * snapshot into AppState so the footer can render the multi-line quota
 * progress bars (line 2+) and hand the rows to a custom status line command.
 *
 * Polling runs while the current model belongs to a managed provider (Kimi).
 * Failures keep the previous snapshot; unchanged snapshots are not re-published.
 */

import { formatDuration } from '@moonshot-ai/kimi-code-oauth';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { isManagedUsageProvider } from '../constant/kimi-tui';
import type { AppState, ManagedUsageSnapshot } from '../types';

const TICK_INTERVAL_MS = 15_000;
const FETCH_INTERVAL_MS = 60_000;

/**
 * Build a human-readable label for a managed-usage row, matching the style
 * used by the /usage panel: "5h limit", "Weekly limit", etc.
 */
function usageRowLabel(row: { readonly name?: string; readonly window?: { unit: string; duration: number } }): string {
  const w = row.window;
  if (w !== undefined) {
    if (w.unit === 'week') return 'Weekly limit';
    return `${String(w.duration)}${w.unit[0] ?? ''} limit`;
  }
  return row.name ?? 'Limit';
}

/**
 * Relative-time reset hint, e.g. "resets in 2h 30m". Returns undefined when
 * the timestamp is missing or unparseable.
 */
function usageRowResetHint(resetAt: string | undefined): string | undefined {
  if (resetAt === undefined) return undefined;
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return undefined;
  const diffSec = Math.floor((parsed - Date.now()) / 1000);
  if (diffSec <= 0) return 'reset';
  return `resets in ${formatDuration(diffSec)}`;
}

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
    // The footer renders quota progress bars on line 2+ whenever managed-
    // usage data is available, and custom status line commands also
    // consume it — so we always poll for managed providers.

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
                label: usageRowLabel(res.summary),
                used: res.summary.used,
                limit: res.summary.limit,
                resetHint: usageRowResetHint(res.summary.resetAt),
              }
            : null,
        limits: res.limits.map((row) => ({
          label: usageRowLabel(row),
          used: row.used,
          limit: row.limit,
          resetHint: usageRowResetHint(row.resetAt),
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
