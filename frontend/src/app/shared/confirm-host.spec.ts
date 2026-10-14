import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmHost } from './confirm-host';
import { ConfirmService } from './confirm.service';

@Component({
  imports: [ConfirmHost],
  template: `
    <button type="button" data-test="opener">Delete</button>
    <app-confirm-host />
  `,
})
class Host {}

function pretendElementsHaveGeometry(): () => void {
  const original = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  return () => { HTMLElement.prototype.getClientRects = original; };
}

/**
 * The confirm dialog: the one place filled danger is allowed (§3), the typed
 * confirmation for the irreversible (phase-07), and the promise the service
 * handed out settling on exactly what was pressed.
 */
describe('ConfirmHost', () => {
  let fixture: ComponentFixture<Host>;
  let confirm: ConfirmService;
  let restoreGeometry: () => void;

  function el(test: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-test=${test}]`);
  }

  function ok(): HTMLButtonElement {
    return el('confirm-ok') as HTMLButtonElement;
  }

  function ask(...args: Parameters<ConfirmService['ask']>): Promise<boolean> {
    const answer = confirm.ask(...args);
    fixture.detectChanges();
    // `focusInitialElementWhenReady` runs in `afterNextRender`, which only an
    // application tick flushes — `detectChanges()` checks the view and no more.
    TestBed.tick();
    fixture.detectChanges();
    return answer;
  }

  function type(text: string): void {
    const input = el('confirm-text') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    restoreGeometry = pretendElementsHaveGeometry();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    confirm = TestBed.inject(ConfirmService);
  });

  afterEach(() => {
    restoreGeometry();
    TestBed.resetTestingModule();
  });

  it('renders nothing until something is asked', () => {
    expect(el('confirm-host')).toBeNull();
  });

  it('opens a modal dialog labelled with the question, and the confirm wears the label it was given', () => {
    void ask('Delete "report.pdf"?', 'Delete');
    const dialog = fixture.nativeElement.querySelector('[role=dialog]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Delete "report.pdf"?');
    expect(dialog.textContent).toContain('Delete "report.pdf"?');
    expect(ok().textContent?.trim()).toBe('Delete');
    expect(ok().classList.contains('btn-danger-filled')).toBe(true);
    expect(el('confirm-cancel')?.textContent?.trim()).toBe('Cancel');
  });

  it('resolves true from the confirm button and closes', async () => {
    const answer = ask('Sure?');
    ok().click();
    fixture.detectChanges();
    await expect(answer).resolves.toBe(true);
    expect(el('confirm-host')).toBeNull();
  });

  it('resolves false from Cancel and closes', async () => {
    const answer = ask('Sure?');
    el('confirm-cancel')!.click();
    fixture.detectChanges();
    await expect(answer).resolves.toBe(false);
    expect(el('confirm-host')).toBeNull();
  });

  it('treats Escape as Cancel', async () => {
    const answer = ask('Sure?');
    fixture.nativeElement.querySelector('[role=dialog]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await expect(answer).resolves.toBe(false);
    expect(el('confirm-host')).toBeNull();
  });

  it('moves focus into the dialog and returns it to the opener afterwards', () => {
    const opener = el('opener')!;
    opener.focus();
    void ask('Sure?');
    const dialog = fixture.nativeElement.querySelector('[role=dialog]') as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Cancel is first in tab order so the dangerous action is never the one a
    // stray Enter lands on.
    expect(document.activeElement).toBe(el('confirm-cancel'));

    el('confirm-cancel')!.click();
    fixture.detectChanges();
    expect(document.activeElement).toBe(opener);
  });

  it('shows one dialog at a time', () => {
    void ask('first');
    void ask('second');
    expect(fixture.nativeElement.querySelectorAll('[data-test=confirm-host]')).toHaveLength(1);
    // Which of the two it asks is not pinned: today the second replaces the
    // first and orphans its promise, a defect (reviewer's note, issue 5).
    const dialog = fixture.nativeElement.querySelector('[role=dialog]') as HTMLElement;
    expect(dialog.getAttribute('aria-label')).toMatch(/^(first|second)$/);
  });

  describe('typed confirmation', () => {
    it('keeps the confirm disabled until the exact text is typed', () => {
      void ask('Empty the trash?', 'Empty trash', 'DELETE');
      expect(el('confirm-text')).not.toBeNull();
      expect(ok().disabled).toBe(true);

      type('delete');
      expect(ok().disabled).toBe(true);
      type('DELET');
      expect(ok().disabled).toBe(true);
      type('DELETE');
      expect(ok().disabled).toBe(false);
    });

    it('forgives surrounding whitespace, which a paste brings along', () => {
      void ask('Empty the trash?', 'Empty trash', 'DELETE');
      type('  DELETE ');
      expect(ok().disabled).toBe(false);
    });

    it('has no text field and no gate when nothing has to be typed', () => {
      void ask('Sure?');
      expect(el('confirm-text')).toBeNull();
      expect(ok().disabled).toBe(false);
    });

    it('never lets a fresh prompt inherit the previous typed confirmation', () => {
      void ask('Empty the trash?', 'Empty trash', 'DELETE');
      type('DELETE');
      expect(ok().disabled).toBe(false);
      ok().click();
      fixture.detectChanges();

      void ask('Delete your account?', 'Delete account', 'DELETE');
      expect((el('confirm-text') as HTMLInputElement).value).toBe('');
      expect(ok().disabled).toBe(true);
    });
  });
});
