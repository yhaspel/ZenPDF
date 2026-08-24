import { MediaMatcher } from '@angular/cdk/layout';
import { Component, inject } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceShellFacade } from '../abstraction/workspace-shell.facade';
import { FakeMediaMatcher } from './fake-media-matcher';
import { WsDrawerHead } from './ws-drawer-head';
import { WsDrawer } from './ws-drawer';

@Component({
  imports: [WsDrawer, WsDrawerHead],
  template: `
    <button id="ws-drawer-open-start" type="button" data-test="opener"
            (click)="shell.toggleDrawer('start')">Tools</button>
    <aside zenWsDrawer="start" zenWsDrawerLabel="Tools" class="ws-rail">
      <app-ws-drawer-head />
      <button type="button" data-test="inside">A tool</button>
    </aside>
  `,
})
class Host {
  readonly shell = inject(WorkspaceShellFacade);
}

/**
 * The rail that becomes a bottom sheet (design contract §3 Phone workspace).
 *
 * Every assertion here is about the three things CSS cannot do — the focus
 * trap, Escape, and the scroll lock — plus the one thing that must *not*
 * happen: none of it on a desk.
 */
describe('WsDrawer', () => {
  let media: FakeMediaMatcher;
  let fixture: ComponentFixture<Host>;
  let shell: WorkspaceShellFacade;

  function build(narrow: boolean) {
    media = new FakeMediaMatcher(narrow);
    TestBed.configureTestingModule({
      providers: [{ provide: MediaMatcher, useValue: media }],
    });
    fixture = TestBed.createComponent(Host);
    shell = TestBed.inject(WorkspaceShellFacade);
    fixture.detectChanges();
  }

  function el(selector: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(selector);
  }

  beforeEach(() => {
    document.body.classList.remove('ws-drawer-locked');
  });

  it('registers itself so the bottom bar can offer an opener', () => {
    build(true);
    expect(shell.barDrawers()).toEqual([{ key: 'start', label: 'Tools', barOpener: true }]);
  });

  it('is a plain rail on a desk — no head, no dialog, no lock', () => {
    build(false);
    shell.toggleDrawer('start');
    fixture.detectChanges();

    const aside = el('[data-ws-drawer=start]')!;
    expect(el('[data-test=ws-drawer]')).toBeNull();
    expect(aside.getAttribute('role')).toBeNull();
    expect(aside.getAttribute('aria-modal')).toBeNull();
    expect(aside.classList.contains('ws-drawer-open')).toBe(false);
    expect(document.body.classList.contains('ws-drawer-locked')).toBe(false);
  });

  it('becomes a labelled dialog with a head, and locks the body, when open', () => {
    build(true);
    const aside = el('[data-ws-drawer=start]')!;
    expect(aside.getAttribute('role')).toBeNull();

    shell.toggleDrawer('start');
    fixture.detectChanges();

    expect(aside.getAttribute('role')).toBe('dialog');
    expect(aside.getAttribute('aria-modal')).toBe('true');
    expect(aside.getAttribute('aria-label')).toBe('Tools');
    expect(aside.classList.contains('ws-drawer-open')).toBe(true);
    expect(el('[data-test=ws-drawer]')).not.toBeNull();
    expect(el('[data-test=ws-drawer-close]')?.getAttribute('aria-label')).toBe('Close Tools');
    expect(document.body.classList.contains('ws-drawer-locked')).toBe(true);
  });

  it('closes on Escape and gives focus back to the opener', () => {
    build(true);
    // The opener is where the person was, and a drawer closed by a key must
    // not drop focus to the top of the document.
    const opener = el('[data-test=opener]')!;
    opener.focus();
    opener.click();
    fixture.detectChanges();

    el('[data-ws-drawer=start]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();

    expect(shell.openDrawer()).toBeNull();
    expect(document.body.classList.contains('ws-drawer-locked')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('closes on the scrim, which is a plain call to the facade', () => {
    build(true);
    shell.toggleDrawer('start');
    fixture.detectChanges();
    expect(shell.anyDrawerOpen()).toBe(true);

    shell.closeDrawer();
    fixture.detectChanges();

    expect(el('[data-ws-drawer=start]')!.classList.contains('ws-drawer-open')).toBe(false);
    expect(document.body.classList.contains('ws-drawer-locked')).toBe(false);
  });

  it('opens and closes in one tick, so reduced motion loses nothing', () => {
    // §1: everything must be fully usable with animation removed. The open
    // state is a class and nothing else — no timer, no animation callback — so
    // a collapsed transition changes when the sheet *slides*, never whether it
    // is there.
    build(true);
    const aside = el('[data-ws-drawer=start]')!;

    shell.toggleDrawer('start');
    fixture.detectChanges();
    expect(aside.classList.contains('ws-drawer-open')).toBe(true);
    expect(aside.style.transition).toBe('');
    expect(aside.style.transform).toBe('');

    shell.toggleDrawer('start');
    fixture.detectChanges();
    expect(aside.classList.contains('ws-drawer-open')).toBe(false);
  });

  it('shuts itself when the viewport widens past the breakpoint', () => {
    // A drawer is a phone shape. Widening mid-session must not leave a trapped
    // `role="dialog"` rail sitting in the desktop three-pane row.
    build(true);
    shell.toggleDrawer('start');
    fixture.detectChanges();
    expect(shell.anyDrawerOpen()).toBe(true);

    media.resize(false);
    fixture.detectChanges();

    expect(shell.phone()).toBe(false);
    expect(shell.anyDrawerOpen()).toBe(false);
    expect(el('[data-ws-drawer=start]')!.getAttribute('role')).toBeNull();
    expect(document.body.classList.contains('ws-drawer-locked')).toBe(false);
  });

  it('withdraws its opener when the mode that owned it goes away', () => {
    build(true);
    expect(shell.barDrawers()).toHaveLength(1);
    fixture.destroy();
    expect(shell.barDrawers()).toHaveLength(0);
  });
});
