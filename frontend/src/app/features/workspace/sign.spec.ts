import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { EsignFacade } from '../../abstraction/esign.facade';
import { Rect } from '../../core/models/models';
import { OverlayMenuAction } from '../../shared/page-overlay/overlay-model';
import { Sign } from './sign';

/**
 * Signature placements (phase-12 D-B, §4.5).
 *
 * Until this phase a placement could not be removed at all. `onSelect` called
 * `unplace`, but the overlay only reports a selection while its tool is
 * `select`, and Sign's tool is `rect` for exactly as long as a signature is
 * armed — which is exactly as long as a placement can exist. So the panel's
 * "Click one to remove it" described a gesture that could never fire.
 */
describe('Sign — placements', () => {
  let fixture: ComponentFixture<Sign>;
  let esign: EsignFacade;

  const api = () => fixture.componentInstance as unknown as {
    onSelect(id: string | null): void;
    removePlacement(id: string): void;
    onContextTarget(id: string | null): void;
    onMenuAction(c: { action: string; itemId: string | null }): void;
    onGeometryChanged(c: { id: string; rect: Rect; from: Rect }): void;
    menuActionsFor(id: string | null): OverlayMenuAction[];
    selectedPlacementId(): string | null;
    placementLabel(i: number, page: number): string;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Sign],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    esign = TestBed.inject(EsignFacade);
    esign.clear();

    fixture = TestBed.createComponent(Sign);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.detectChanges();
    esign.clear(); // the component resets on construction; start from empty
  });

  afterEach(() => TestBed.resetTestingModule());

  function place(): string {
    esign.place(0, { x: 0.2, y: 0.7, w: 0.2, h: 0.06 });
    return esign.placements()[esign.placements().length - 1].id;
  }

  it('can select a placement — which was not previously possible at all', () => {
    const id = place();
    api().onSelect(id);
    expect(esign.placements().length).toBe(1);
    expect(api().selectedPlacementId()).toBe(id);
  });

  it('can remove one, from the list or the menu', () => {
    const id = place();
    api().onContextTarget(id);
    expect(api().menuActionsFor(id).map((a) => a.id)).toEqual(['remove']);

    api().onMenuAction({ action: 'remove', itemId: id });
    expect(esign.placements().length).toBe(0);
    expect(api().selectedPlacementId()).toBeNull();
  });

  it('brings a removed placement back on undo', () => {
    const id = place();
    api().removePlacement(id);
    esign.undoPlacements();
    expect(esign.placements().length).toBe(1);
  });

  it('moves a placement rather than only accepting a new one', () => {
    const id = place();
    const from = { x: 0.2, y: 0.7, w: 0.2, h: 0.06 };
    api().onGeometryChanged({ id, from, rect: { ...from, y: 0.4 } });
    expect(esign.placements()[0].rect.y).toBeCloseTo(0.4);
  });

  it('offers no menu for something that is not a placement', () => {
    api().onContextTarget('nope');
    expect(api().menuActionsFor('nope')).toEqual([]);
  });

  it('names each row so the list is usable without looking at the page', () => {
    expect(api().placementLabel(0, 2)).toBe('Signature 1 · page 3');
  });

  it('undoes and redoes from the keyboard, as the buttons say it does', () => {
    // The buttons carry `aria-keyshortcuts="Control+Z Meta+Z"`; a declared
    // shortcut that is not bound is worse than none, because a screen reader
    // reads it out.
    const id = place();
    api().removePlacement(id);
    expect(esign.placements().length).toBe(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    expect(esign.placements().length).toBe(1);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }),
    );
    expect(esign.placements().length).toBe(0);
  });

  it('leaves the keyboard alone while a field has focus', () => {
    const id = place();
    api().removePlacement(id);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true,
    }));
    expect(esign.placements().length).toBe(0);
    input.remove();
  });
});
