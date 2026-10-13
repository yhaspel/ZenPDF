import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ZenModal } from './modal.directive';

@Component({
  imports: [ZenModal],
  template: `
    <button type="button" data-test="opener" (click)="open.set(true)">Open</button>
    <input data-test="behind" />
    @if (open()) {
      <!-- A scrim around the dialog, as every product modal has: the trap
           attaches its anchors beside the host element at construction, which
           needs a parent to attach them to. -->
      <div class="scrim">
        <div zenModal role="dialog" aria-modal="true" aria-label="A dialog"
             data-test="dialog" (zenModalEscape)="escapes = escapes + 1">
          <p>Some text</p>
          <button type="button" data-test="first">First</button>
          <input data-test="middle" />
          <button type="button" data-test="last">Last</button>
        </div>
      </div>
    }
  `,
})
class Host {
  readonly open = signal(false);
  escapes = 0;
}

/**
 * jsdom lays nothing out, and CDK's `InteractivityChecker` treats an element
 * with no geometry as invisible and therefore not focusable. Giving every
 * element one client rect is the smallest lie that lets the trap behave as
 * it does in a browser.
 */
function pretendElementsHaveGeometry(): () => void {
  const original = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  return () => { HTMLElement.prototype.getClientRects = original; };
}

/**
 * What a dialog owes a keyboard user (§10.3): focus goes in, stays in, comes
 * back — and Escape is the way out, with the host deciding what that means.
 */
describe('ZenModal', () => {
  let fixture: ComponentFixture<Host>;
  let restoreGeometry: () => void;

  function el(test: string): HTMLElement {
    return fixture.nativeElement.querySelector(`[data-test=${test}]`);
  }

  function anchors(): HTMLElement[] {
    const root = fixture.nativeElement as HTMLElement;
    return [...root.querySelectorAll<HTMLElement>('.cdk-focus-trap-anchor')];
  }

  function open(): void {
    el('opener').click();
    fixture.detectChanges();
    // `focusInitialElementWhenReady` runs in `afterNextRender`, which only an
    // application tick flushes — `detectChanges()` checks the view and no more.
    TestBed.tick();
    fixture.detectChanges();
  }

  beforeEach(() => {
    restoreGeometry = pretendElementsHaveGeometry();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  afterEach(() => {
    restoreGeometry();
    TestBed.resetTestingModule();
  });

  it('moves focus into the dialog, onto its first tabbable control', () => {
    el('opener').focus();
    open();
    expect(document.activeElement).toBe(el('first'));
  });

  it('keeps focus inside: tabbing past the end wraps to the first control, and before the start to the last', () => {
    open();
    const [start, end] = anchors();
    expect(anchors()).toHaveLength(2);
    // CDK's trap is two sentinel anchors either side of the dialog; the
    // keyboard reaches them when Tab leaves the last control (or Shift+Tab the
    // first), and focusing one is what a browser does at that moment.
    end.focus();
    expect(document.activeElement).toBe(el('first'));
    start.focus();
    expect(document.activeElement).toBe(el('last'));
  });

  it('tells the host on Escape and keeps the key to itself', () => {
    open();
    let reachedDocument = false;
    const listener = () => { reachedDocument = true; };
    document.addEventListener('keydown', listener);
    try {
      el('middle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } finally {
      document.removeEventListener('keydown', listener);
    }
    expect(fixture.componentInstance.escapes).toBe(1);
    expect(reachedDocument).toBe(false);
  });

  it('does not treat any other key as Escape', () => {
    open();
    el('middle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el('middle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(fixture.componentInstance.escapes).toBe(0);
  });

  it('gives focus back to whatever opened it, and removes its anchors, when it closes', () => {
    const opener = el('opener');
    opener.focus();
    open();
    expect(document.activeElement).not.toBe(opener);

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    expect(document.activeElement).toBe(opener);
    expect(anchors()).toHaveLength(0);
  });
});
