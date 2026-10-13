import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmService } from './confirm.service';

/**
 * `ask()` is a promise the host settles. What matters: the promise answers
 * exactly what was pressed, the request is gone once answered, and an answer
 * with nothing open is a no-op rather than a crash.
 */
describe('ConfirmService', () => {
  let confirm: ConfirmService;

  beforeEach(() => {
    confirm = TestBed.inject(ConfirmService);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('publishes the request with its label and defaults', () => {
    void confirm.ask('Delete this document?');
    expect(confirm.current()).toMatchObject({
      message: 'Delete this document?',
      confirmLabel: 'Confirm',
      requireText: undefined,
    });
  });

  it('carries a custom label and the text the person must type', () => {
    void confirm.ask('Empty the trash?', 'Empty trash', 'DELETE');
    expect(confirm.current()).toMatchObject({ confirmLabel: 'Empty trash', requireText: 'DELETE' });
  });

  it('resolves true on confirm and clears the request', async () => {
    const answer = confirm.ask('Sure?');
    confirm.answer(true);
    await expect(answer).resolves.toBe(true);
    expect(confirm.current()).toBeNull();
  });

  it('resolves false on cancel and clears the request', async () => {
    const answer = confirm.ask('Sure?');
    confirm.answer(false);
    await expect(answer).resolves.toBe(false);
    expect(confirm.current()).toBeNull();
  });

  it('stays pending until somebody answers', async () => {
    let settled = false;
    void confirm.ask('Sure?').then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(confirm.current()).not.toBeNull();
  });

  it('ignores an answer when nothing is being asked', () => {
    expect(() => confirm.answer(true)).not.toThrow();
    expect(confirm.current()).toBeNull();
  });

  it('holds one request at a time: a second ask replaces the first', async () => {
    void confirm.ask('first');
    const second = confirm.ask('second');
    expect(confirm.current()?.message).toBe('second');
    confirm.answer(true);
    await expect(second).resolves.toBe(true);
    // What happens to the replaced promise is deliberately not pinned here:
    // today it is never settled (its caller hangs), which is a defect, not a
    // contract — see the reviewer's note on ConfirmService.ask().
  });
});
