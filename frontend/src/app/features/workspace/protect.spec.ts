import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SecurityFacade } from '../../abstraction/security.facade';
import { Rect } from '../../core/models/models';
import { OverlayItem, OverlayMenuAction } from '../../shared/page-overlay/overlay-model';
import { Protect, strengthOf } from './protect';

/**
 * The strength meter is the one piece of judgement in the Protect panel, and a
 * meter that lies is worse than no meter: it teaches people to add punctuation
 * to a short word instead of making the word longer.
 */
describe('strengthOf', () => {
  it('says nothing about an empty box', () => {
    expect(strengthOf('')).toEqual({ score: 0, label: '' });
  });

  it('calls a short password short, however clever it is', () => {
    expect(strengthOf('aB3!').label).toBe('Too short');
    expect(strengthOf('Pw9$xQ2').label).toBe('Too short');
  });

  it('rates a long passphrase strong even with no punctuation', () => {
    expect(strengthOf('correct horse battery staple').score).toBe(3);
    expect(strengthOf('the quiet river bend').label).toBe('Strong');
  });

  it('does not call a short mixed-case password strong', () => {
    // 'P@ssw0rd!' has all four character classes and is famously terrible.
    expect(strengthOf('P@ssw0rd!').score).toBeLessThan(3);
  });

  it('rewards length over class variety at the margin', () => {
    expect(strengthOf('aaaaaaaaaaaaaaaa').score).toBe(3); // 16 chars
    expect(strengthOf('aA1!aA1!').score).toBe(1); // 8 chars, four classes
  });
});

/**
 * The redaction layer's selection (phase-12 D-C, §4.4).
 *
 * `onSelect` used to call `removeArea` — a left-click on a marked area deleted
 * it, with no confirm, no undo and no other way to remove one, and the panel
 * told people to do exactly that. The regression this file guards is simple:
 * clicking selects.
 */
describe('Protect — redaction areas', () => {
  let fixture: ComponentFixture<Protect>;
  let security: SecurityFacade;

  const api = () => fixture.componentInstance as unknown as {
    onSelect(id: string | null): void;
    removeArea(id: string): void;
    onContextTarget(id: string | null): void;
    onMenuAction(c: { action: string; itemId: string | null }): void;
    onGeometryChanged(c: { id: string; rect: Rect; from: Rect }): void;
    menuActionsFor(id: string | null): OverlayMenuAction[];
    selectedAreaId(): string | null;
    overlayItems(): OverlayItem[];
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Protect],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    security = TestBed.inject(SecurityFacade);
    security.clear();

    fixture = TestBed.createComponent(Protect);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('initialTab', 'redact');
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  function firstAreaId(): string {
    return security.areas()[0].id;
  }

  it('selects an area on a click instead of destroying it', () => {
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const id = firstAreaId();

    api().onSelect(id);

    expect(security.areas().length).toBe(1);
    expect(api().selectedAreaId()).toBe(id);
  });

  it('removes an area when actually asked to', () => {
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const id = firstAreaId();
    api().onSelect(id);

    api().removeArea(id);

    expect(security.areas().length).toBe(0);
    expect(api().selectedAreaId()).toBeNull();
  });

  it('brings a removed area back on undo', () => {
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    api().removeArea(firstAreaId());
    expect(security.canUndo()).toBe(true);

    security.undoAreas();

    expect(security.areas().length).toBe(1);
    expect(security.canRedo()).toBe(true);
  });

  it('moves an area, so the selection handles are wired to something', () => {
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const id = firstAreaId();
    const from = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };

    api().onGeometryChanged({ id, from, rect: { ...from, x: 0.5 } });

    expect(security.areas()[0].rect.x).toBeCloseTo(0.5);
    security.undoAreas();
    expect(security.areas()[0].rect.x).toBeCloseTo(0.1);
  });

  it('offers Remove on a drawn area', () => {
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const id = firstAreaId();
    api().onContextTarget(id);

    const actions = api().menuActionsFor(id);
    expect(actions.map((a) => a.id)).toEqual(['remove']);
    expect(actions[0].danger).toBe(true);

    api().onMenuAction({ action: 'remove', itemId: id });
    expect(security.areas().length).toBe(0);
  });

  it('offers nothing on a pattern match, which is unticked rather than deleted', () => {
    api().onContextTarget('m-not-an-area');
    expect(api().menuActionsFor('m-not-an-area')).toEqual([]);
  });

  it('keeps pattern matches locked, so a drag cannot move a found match', () => {
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const drawn = api().overlayItems().find((i) => i.id === firstAreaId());
    expect(drawn?.locked).toBeFalsy();
  });

  it('undoes and redoes from the keyboard, as the buttons say it does', () => {
    // The buttons carry `aria-keyshortcuts="Control+Z Meta+Z"`, so the binding
    // has to exist — a shortcut announced by a screen reader and bound to
    // nothing is worse than no shortcut at all.
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    expect(security.areas().length).toBe(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(security.areas().length).toBe(0);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }),
    );
    expect(security.areas().length).toBe(1);
  });

  it('leaves the keyboard alone while a password field has focus', () => {
    security.addArea(0, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true,
    }));
    expect(security.areas().length).toBe(1);
    input.remove();
  });
});
