/**
 * Single source of truth for `x/y tool(s)` rendering.
 *
 * - `ongoing` is the in-flight count (running sub-tool calls).
 * - `total` is the cumulative count (ongoing + finished + collapsed past cap).
 *
 * Plural follows `total` (matches the pre-x/y behaviour): `0/1 tool`,
 * `1/2 tools`. Returns `null` when total is 0 so callers can skip the
 * segment without an extra guard.
 */
export function formatToolCount(ongoing: number, total: number): string | null {
  if (total <= 0) return null;
  // Clamp so a misbehaving caller (e.g. a phase-aware fold that over-counts)
  // cannot surface an absurd `2/1 tools` to the user.
  const safeOngoing = Math.max(0, Math.min(ongoing, total));
  return `${String(safeOngoing)}/${String(total)} tool${total === 1 ? '' : 's'}`;
}