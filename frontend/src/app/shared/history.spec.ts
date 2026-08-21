import { HistoryStack } from './history';

/**
 * The undo machinery five facades now share (phase-12 D3).
 *
 * Tested directly rather than only through a facade, because every one of them
 * inherits whatever this gets wrong — and an undo stack that is subtly wrong
 * loses work silently, which is the worst failure mode a text editor has.
 */
describe('HistoryStack', () => {
  it('has nothing to undo or redo when it is new', () => {
    const history = new HistoryStack<string>();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undo('now')).toBeUndefined();
    expect(history.redo('now')).toBeUndefined();
  });

  it('walks back through the states in the order they were remembered', () => {
    const history = new HistoryStack<string>();
    history.remember('a');
    history.remember('b');

    expect(history.undo('c')).toBe('b');
    expect(history.undo('b')).toBe('a');
    expect(history.undo('a')).toBeUndefined();
  });

  it('walks forward again, ending where it started', () => {
    const history = new HistoryStack<string>();
    history.remember('a');
    history.remember('b');
    history.undo('c');
    history.undo('b');

    expect(history.canRedo()).toBe(true);
    expect(history.redo('a')).toBe('b');
    expect(history.redo('b')).toBe('c');
    expect(history.canRedo()).toBe(false);
  });

  it('drops the future as soon as something new happens', () => {
    // Undoing and then editing is the commonest way to reach this, and a redo
    // that then jumped forward to a branch the user abandoned would replace
    // their new work with their old.
    const history = new HistoryStack<string>();
    history.remember('a');
    history.undo('b');
    expect(history.canRedo()).toBe(true);

    history.remember('a2');
    expect(history.canRedo()).toBe(false);
    expect(history.redo('b2')).toBeUndefined();
  });

  it('evicts the oldest step at the cap, never the newest', () => {
    // A cap that dropped the most recent entry would make the very next ⌘Z do
    // nothing — the one press that has to work.
    const history = new HistoryStack<number>(3);
    history.remember(1);
    history.remember(2);
    history.remember(3);
    history.remember(4);

    expect(history.depth.past).toBe(3);
    expect(history.undo(5)).toBe(4);
    expect(history.undo(4)).toBe(3);
    expect(history.undo(3)).toBe(2);
    expect(history.undo(2)).toBeUndefined(); // 1 was evicted
  });

  it('forgets everything on clear', () => {
    const history = new HistoryStack<string>();
    history.remember('a');
    history.undo('b');
    history.clear();

    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.depth).toEqual({ past: 0, future: 0 });
  });

  it('tracks both directions in signals the buttons can bind to', () => {
    const history = new HistoryStack<string>();
    expect(history.canUndo()).toBe(false);
    history.remember('a');
    expect(history.canUndo()).toBe(true);
    history.undo('b');
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });
});
