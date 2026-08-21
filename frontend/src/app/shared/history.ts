import { Signal, signal } from '@angular/core';

/**
 * Undo / redo over whole snapshots (phase-12 D3).
 *
 * Lifted verbatim out of `AnnotationsFacade`, where the design was worked out
 * in Phase 3 and has held since: **snapshot the entire local state and restore
 * it whole**, rather than recording an operation and replaying its inverse. An
 * inverse has to be derived correctly for every kind of edit — a moved quad, a
 * deleted draft, a rename that was really a delete-then-add — and the first one
 * derived wrongly corrupts the document quietly. A snapshot cannot be wrong; it
 * costs a shallow copy per gesture, which is nothing beside being right.
 *
 * The class knows nothing about what a snapshot *is*. Five facades hand it five
 * different shapes (a Map of annotations, a Map of block edits, an array of
 * field ops, an array of redaction areas, an array of placements) and it treats
 * all of them as opaque.
 *
 * **The caller owns immutability.** `remember` stores the reference it is
 * given, so a caller that hands over a live object and then mutates it has
 * poisoned its own history. Every caller here passes a fresh copy, which is
 * also what its signal-based store does anyway.
 */
export class HistoryStack<T> {
  private past: T[] = [];
  private future: T[] = [];
  private readonly _canUndo = signal(false);
  private readonly _canRedo = signal(false);

  readonly canUndo: Signal<boolean> = this._canUndo.asReadonly();
  readonly canRedo: Signal<boolean> = this._canRedo.asReadonly();

  /**
   * @param limit how many steps to keep. A session is one sitting; a hundred
   * steps is further back than anyone reaches for, and the cap is what keeps a
   * long markup session's memory bounded.
   */
  constructor(private readonly limit = 100) {}

  /** Record the state *before* a change, and abandon any redo future. */
  remember(snapshot: T): void {
    this.past.push(snapshot);
    // Evict the oldest, never the newest: a cap that dropped the most recent
    // step would make the very next ⌘Z do nothing.
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.sync();
  }

  /** The state to go back to, or `undefined` if there is none. */
  undo(current: T): T | undefined {
    const previous = this.past.pop();
    if (previous === undefined) return undefined;
    this.future.push(current);
    this.sync();
    return previous;
  }

  /** The state to go forward to, or `undefined` if there is none. */
  redo(current: T): T | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(current);
    this.sync();
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.sync();
  }

  /** Steps available in each direction — for tests and for debugging. */
  get depth(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  private sync(): void {
    this._canUndo.set(this.past.length > 0);
    this._canRedo.set(this.future.length > 0);
  }
}
