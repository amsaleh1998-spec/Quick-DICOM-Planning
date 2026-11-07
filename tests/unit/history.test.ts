// The undo history: steps hold only the parts that changed; redo is dropped by a new change.
import { describe, expect, it } from 'vitest';
import { History } from '../../src/history';

function plan() {
  const state = { a: 1, b: 'x' };
  const restored: string[] = [];
  const h = new History({
    a: { label: 'A', key: () => String(state.a), restore: (k) => (restored.push('a'), (state.a = Number(k))) },
    b: { label: 'B', key: () => state.b, restore: (k) => (restored.push('b'), (state.b = k)) },
  });
  return { state, restored, h };
}

describe('undo history', () => {
  it('undoes and redoes step by step, restoring only what changed', () => {
    const { state, restored, h } = plan();
    state.a = 2;
    h.commit();
    state.b = 'y';
    h.commit();
    expect(h.undoCount).toBe(2);
    expect(h.undo()).toEqual(['B']);
    expect(state).toEqual({ a: 2, b: 'x' });
    expect(restored).toEqual(['b']);
    expect(h.undo()).toEqual(['A']);
    expect(state).toEqual({ a: 1, b: 'x' });
    expect(h.undo()).toBeNull();
    expect(h.redo()).toEqual(['A']);
    expect(h.redo()).toEqual(['B']);
    expect(state).toEqual({ a: 2, b: 'y' });
  });

  it('records edits not committed yet before undoing them', () => {
    const { state, h } = plan();
    state.a = 5;
    expect(h.undoCount).toBe(1);
    h.undo();
    expect(state.a).toBe(1);
    expect(h.redoCount).toBe(1);
  });

  it('drops redo after a new change, ignores commits without change, starts over on reset', () => {
    const { state, h } = plan();
    state.a = 2;
    h.commit();
    h.undo();
    expect(h.redoCount).toBe(1);
    expect(h.commit()).toBe(false);
    expect(h.redoCount).toBe(1);
    state.b = 'z';
    h.commit();
    expect(h.redoCount).toBe(0);
    h.reset();
    expect(h.undoCount).toBe(0);
  });
});
