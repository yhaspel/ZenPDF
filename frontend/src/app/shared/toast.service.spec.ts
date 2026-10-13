import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastService } from './toast.service';

/**
 * A toast is a receipt that leaves on its own; an error is a sentence that
 * has to be read, so it stays twice as long (§10.3). The timings are the
 * behaviour here, so the clock is faked.
 */
describe('ToastService', () => {
  let toasts: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    toasts = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  const messages = () => toasts.toasts().map((t) => t.message);

  it('starts empty and shows what it is told, in order', () => {
    expect(toasts.toasts()).toEqual([]);
    toasts.success('Merged');
    toasts.error('Upload failed');
    toasts.info('Saved');
    expect(toasts.toasts().map((t) => [t.message, t.type])).toEqual([
      ['Merged', 'success'],
      ['Upload failed', 'error'],
      ['Saved', 'info'],
    ]);
  });

  it('gives every toast its own id, even for the same message twice', () => {
    toasts.info('Saved');
    toasts.info('Saved');
    const [a, b] = toasts.toasts();
    expect(a.id).not.toBe(b.id);
  });

  it('dismisses one toast by id and leaves the others', () => {
    toasts.info('one');
    toasts.info('two');
    toasts.info('three');
    const [, two] = toasts.toasts();
    toasts.dismiss(two.id);
    expect(messages()).toEqual(['one', 'three']);
  });

  it('ignores a dismiss for an id that is already gone', () => {
    toasts.info('one');
    const [one] = toasts.toasts();
    toasts.dismiss(one.id);
    expect(() => toasts.dismiss(one.id)).not.toThrow();
    expect(toasts.toasts()).toEqual([]);
  });

  it.each([
    ['success', 4500],
    ['info', 4500],
    ['error', 9000],
  ] as const)('lets a %s toast stay for %ims and no longer', (type, ms) => {
    toasts.show('hello', type);
    vi.advanceTimersByTime(ms - 1);
    expect(messages()).toEqual(['hello']);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it('honours an explicit duration over the default for its type', () => {
    toasts.error('brief', 1000);
    toasts.success('long', 20_000);
    vi.advanceTimersByTime(1000);
    expect(messages()).toEqual(['long']);
    vi.advanceTimersByTime(19_000);
    expect(messages()).toEqual([]);
  });

  it('expires each toast on its own clock, not the stack as one', () => {
    toasts.info('first');
    vi.advanceTimersByTime(3000);
    toasts.info('second');
    vi.advanceTimersByTime(1500);
    expect(messages()).toEqual(['second']);
    vi.advanceTimersByTime(3000);
    expect(messages()).toEqual([]);
  });

  it('does not resurrect or disturb anything when a dismissed toast expires', () => {
    toasts.info('gone early');
    toasts.info('stays');
    const [early] = toasts.toasts();
    toasts.dismiss(early.id);
    vi.advanceTimersByTime(4500);
    expect(messages()).toEqual([]);
  });
});
