import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { ViewerTabOrder } from './viewer-tab-order';

/**
 * A stand-in for the vendor viewer: the directive only needs an element with
 * that tag name that fires `pageRendered`, and the shell of focusables it
 * renumbers underneath.
 */
@Component({
  imports: [ViewerTabOrder],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <button type="button" tabindex="0" data-test="back">Back</button>
    <button type="button" tabindex="3" data-test="outside">Not the viewer's</button>
    <ngx-extended-pdf-viewer zenViewerTabOrder>
      <button type="button" tabindex="1" data-test="zoom">Zoom</button>
      <button type="button" tabindex="2" data-test="next">Next</button>
      <input tabindex="152" data-test="page" />
      <div tabindex="-1" data-test="roving">A roving-focus item</div>
      <button type="button" tabindex="0" data-test="plain">Already fine</button>
      <button type="button" data-test="untouched">No tabindex at all</button>
    </ngx-extended-pdf-viewer>
  `,
})
class Host {}

/**
 * WCAG 2.4.3, as a test. The vendor numbers 152 controls with a positive
 * tabindex, which puts every one of them ahead of the back link. After a
 * page paints they all have to be back at 0 — and the library's own `-1`
 * roving groups have to be left exactly as they were.
 */
describe('ViewerTabOrder', () => {
  let fixture: ComponentFixture<Host>;

  function el(test: string): HTMLElement {
    return fixture.nativeElement.querySelector(`[data-test=${test}]`);
  }

  beforeEach(() => {
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('leaves the vendor numbering alone until a page has painted', () => {
    expect(el('zoom').tabIndex).toBe(1);
    expect(el('page').tabIndex).toBe(152);
  });

  it('flattens every positive tabindex in the viewer to 0 once a page renders', () => {
    el('zoom').parentElement!.dispatchEvent(new CustomEvent('pageRendered'));
    expect(el('zoom').tabIndex).toBe(0);
    expect(el('next').tabIndex).toBe(0);
    expect(el('page').tabIndex).toBe(0);
    expect(el('plain').tabIndex).toBe(0);
  });

  it('leaves negative tabindexes alone — they are how roving focus works', () => {
    el('zoom').parentElement!.dispatchEvent(new CustomEvent('pageRendered'));
    expect(el('roving').tabIndex).toBe(-1);
    expect(el('roving').getAttribute('tabindex')).toBe('-1');
  });

  it('does not touch elements with no tabindex attribute, and stays inside the viewer', () => {
    el('zoom').parentElement!.dispatchEvent(new CustomEvent('pageRendered'));
    expect(el('untouched').hasAttribute('tabindex')).toBe(false);
    expect(el('back').getAttribute('tabindex')).toBe('0');
    // A positive tabindex outside the viewer is not the vendor's, so it is not
    // the directive's to flatten.
    expect(el('outside').tabIndex).toBe(3);
  });

  it('is idempotent across repeated paints', () => {
    const viewer = el('zoom').parentElement!;
    viewer.dispatchEvent(new CustomEvent('pageRendered'));
    const after = [...viewer.querySelectorAll<HTMLElement>('[tabindex]')].map((e) => e.tabIndex);
    viewer.dispatchEvent(new CustomEvent('pageRendered'));
    expect([...viewer.querySelectorAll<HTMLElement>('[tabindex]')].map((e) => e.tabIndex)).toEqual(after);
    expect(after).toEqual([0, 0, 0, -1, 0]);
  });
});
