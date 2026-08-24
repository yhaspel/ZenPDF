import { MediaMatcher } from '@angular/cdk/layout';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { FakeMediaMatcher } from '../../shared/fake-media-matcher';
import { WORKSPACE_MODES, WorkspaceMode, WsBottomBar } from './ws-bottom-bar';

/**
 * The phone bottom bar (design contract §3 Phone workspace).
 *
 * The row is `.seg`'s semantics in a different shape: plain buttons carrying
 * `aria-pressed`, in a `role="group"` — never `aria-selected`, never
 * `role="tablist"`. Both of those shipped once and were caught only after a
 * contrast failure stopped masking them (§11, 2026-08-10).
 */
describe('WsBottomBar', () => {
  let fixture: ComponentFixture<WsBottomBar>;
  let shell: WorkspaceShellFacade;

  function build(mode: WorkspaceMode = 'view') {
    TestBed.configureTestingModule({
      providers: [{ provide: MediaMatcher, useValue: new FakeMediaMatcher(true) }],
    });
    fixture = TestBed.createComponent(WsBottomBar);
    shell = TestBed.inject(WorkspaceShellFacade);
    fixture.componentRef.setInput('mode', mode);
    fixture.detectChanges();
  }

  function all(selector: string): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll(selector));
  }

  it('draws the nine modes, in the bar order, with the active one pressed', () => {
    build('annotate');
    const buttons = all('[data-test=ws-bottom-mode]');

    expect(buttons.map((b) => b.getAttribute('data-mode'))).toEqual(
      WORKSPACE_MODES.map((m) => m.key),
    );
    expect(buttons).toHaveLength(9);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(
      WORKSPACE_MODES.map((m) => String(m.key === 'annotate')),
    );
    // The ink stamp, not the accent (§3 `.seg`).
    expect(all('.seg-active').map((b) => b.getAttribute('data-mode'))).toEqual(['annotate']);
  });

  it('is a group of buttons, not a tablist', () => {
    build();
    const row = fixture.nativeElement.querySelector('.ws-bottom-modes');
    expect(row.getAttribute('role')).toBe('group');
    expect(row.getAttribute('aria-label')).toBe('Workspace mode');
    expect(fixture.nativeElement.querySelectorAll('[role=tab], [aria-selected]')).toHaveLength(0);
  });

  it('emits the mode that was tapped', () => {
    build('view');
    const emitted: WorkspaceMode[] = [];
    fixture.componentInstance.modeChange.subscribe((m) => emitted.push(m));

    all('[data-test=ws-bottom-mode]')[3].click();
    all('[data-test=ws-bottom-mode]')[0].click();

    expect(emitted).toEqual(['annotate', 'view']);
  });

  it('tapping the mode already on selects it again rather than toggling to View', () => {
    // The desktop `.seg` toggles back to View on a second click. On a phone the
    // same tap is how a person checks where they are, and View is the first
    // button in the row — the way out is visible, not hidden in a gesture.
    build('annotate');
    const emitted: WorkspaceMode[] = [];
    fixture.componentInstance.modeChange.subscribe((m) => emitted.push(m));

    all('[data-test=ws-bottom-mode]')[3].click();

    expect(emitted).toEqual(['annotate']);
  });

  it('offers an opener for every rail the mode registered, and none for More', () => {
    build();
    shell.registerDrawer({ key: 'start', label: 'Tools', barOpener: true });
    shell.registerDrawer({ key: 'end', label: 'Comments', barOpener: true });
    shell.registerDrawer({ key: 'more', label: 'More', barOpener: false });
    fixture.detectChanges();

    const openers = all('[data-test=ws-drawer-open]');
    expect(openers.map((b) => b.textContent?.trim())).toEqual(['Tools', 'Comments']);
    expect(openers.map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expect(openers.map((b) => b.getAttribute('aria-controls')))
      .toEqual(['ws-drawer-start', 'ws-drawer-end']);
    // The id the drawer sends focus back to when it closes.
    expect(openers.map((b) => b.id)).toEqual(['ws-drawer-open-start', 'ws-drawer-open-end']);
  });

  it('an opener toggles its own drawer and says so', () => {
    build();
    shell.registerDrawer({ key: 'start', label: 'Tools', barOpener: true });
    fixture.detectChanges();

    all('[data-test=ws-drawer-open]')[0].click();
    fixture.detectChanges();
    expect(shell.openDrawer()).toBe('start');
    expect(all('[data-test=ws-drawer-open]')[0].getAttribute('aria-expanded')).toBe('true');

    all('[data-test=ws-drawer-open]')[0].click();
    fixture.detectChanges();
    expect(shell.openDrawer()).toBeNull();
  });

  it('docks the mode’s Undo, Redo and primary, and runs them', () => {
    build('annotate');
    const ran: string[] = [];
    shell.setPaneActions({
      undo: { label: 'Undo', disabled: false, run: () => ran.push('undo') },
      redo: { label: 'Redo', disabled: true, run: () => ran.push('redo') },
      primary: { label: 'Save', disabled: false, run: () => ran.push('save') },
    });
    fixture.detectChanges();

    const undo = fixture.nativeElement.querySelector('[data-test=ws-bottom-undo]');
    const redo = fixture.nativeElement.querySelector('[data-test=ws-bottom-redo]');
    const primary = fixture.nativeElement.querySelector('[data-test=ws-bottom-primary]');

    // Icon buttons, so the label is the accessible name rather than the text.
    expect(undo.getAttribute('aria-label')).toBe('Undo');
    expect(redo.disabled).toBe(true);
    expect(primary.textContent.trim()).toBe('Save');

    undo.click();
    redo.click();
    primary.click();

    expect(ran).toEqual(['undo', 'save']);
  });

  it('draws nothing in the dock for a mode that publishes nothing', () => {
    // Convert has three peer actions and no single primary, so it publishes
    // none — and an empty dock is the honest answer, not a disabled Save.
    build('convert');
    shell.setPaneActions({});
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-test=ws-bottom-undo]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test=ws-bottom-primary]')).toBeNull();
  });
});
