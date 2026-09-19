import { describe, expect, it } from 'vitest';

import { formatToolCount } from '#/tui/components/messages/tool-count-format';

describe('formatToolCount', () => {
  it('returns null when total is zero (caller skips the segment)', () => {
    expect(formatToolCount(0, 0)).toBeNull();
  });

  it('uses singular "tool" when total is 1 regardless of ongoing', () => {
    expect(formatToolCount(0, 1)).toBe('0/1 tool');
    expect(formatToolCount(1, 1)).toBe('1/1 tool');
  });

  it('uses plural "tools" when total is 2+', () => {
    expect(formatToolCount(0, 2)).toBe('0/2 tools');
    expect(formatToolCount(1, 5)).toBe('1/5 tools');
    expect(formatToolCount(7, 7)).toBe('7/7 tools');
  });

  it('returns null for negative total defensively', () => {
    expect(formatToolCount(0, -1)).toBeNull();
    expect(formatToolCount(-1, 0)).toBeNull();
  });

  it('clamps ongoing above total so misbehaving callers cannot surface absurd counts', () => {
    expect(formatToolCount(3, 1)).toBe('1/1 tool');
    expect(formatToolCount(7, 5)).toBe('5/5 tools');
  });
});