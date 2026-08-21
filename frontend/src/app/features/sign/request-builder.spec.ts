import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { EMPTY } from 'rxjs';

import { EsignService } from '../../core/services/esign.service';
import { OverlayDraft, OverlayMenuAction } from '../../shared/page-overlay/overlay-model';
import { RequestBuilder } from './request-builder';

/**
 * The signature request builder's field layer (phase-12 §4.6).
 *
 * It shares `PageOverlay` with the workspace, and it shared the workspace's
 * worst habit: `onSelect` filtered the clicked field straight out of the list.
 * In a builder where twenty minutes of placement is normal, a mis-aimed click
 * silently threw work away with no undo.
 */
describe('RequestBuilder — placing fields', () => {
  let fixture: ComponentFixture<RequestBuilder>;

  const api = () => fixture.componentInstance as unknown as {
    fields(): { recipient_id: string; page: number; x: number; y: number }[];
    fieldsOnPage(): { id: string; field: { type: string } }[];
    selectedFieldId(): string | null;
    armedFor: { set(v: string | null): void };
    recipients: { set(v: unknown[]): void };
    onDrawn(d: OverlayDraft): void;
    onSelect(id: string | null): void;
    removeField(id: string | null): void;
    onContextTarget(id: string | null): void;
    onMenuAction(c: { action: string; itemId: string | null }): void;
    onGeometryChanged(c: { id: string; rect: { x: number; y: number; w: number; h: number };
                          from: { x: number; y: number; w: number; h: number } }): void;
    menuActionsFor(id: string | null): OverlayMenuAction[];
    undoFields(): void;
    canUndo(): boolean;
    colorFor(id: string): string;
    step: { set(v: number): void };
  };

  beforeEach(() => {
    const fakeEsign: Partial<EsignService> = {
      // The draft request is the step this file does not exercise; an empty
      // stream leaves the component in step 1 with its own state intact.
      createRequest: () => EMPTY as never,
    };
    TestBed.configureTestingModule({
      imports: [RequestBuilder],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: EsignService, useValue: fakeEsign },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ docId: 'doc-1' }) } },
        },
      ],
    });
    fixture = TestBed.createComponent(RequestBuilder);
    fixture.detectChanges();
    api().recipients.set([{ id: 'r1', email: 'a@example.com', name: '', role: 'signer', order: 1 }]);
    api().armedFor.set('r1');
  });

  afterEach(() => TestBed.resetTestingModule());

  function draw(): void {
    api().onDrawn({ shape: 'rect', page: 0, rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.05 } });
  }

  it('selects a field on a click instead of deleting it', () => {
    draw();
    api().onSelect('0');
    expect(api().fields().length).toBe(1);
    expect(api().selectedFieldId()).toBe('0');
  });

  it('removes one when actually asked, from the list or the menu', () => {
    draw();
    api().onContextTarget('0');
    expect(api().menuActionsFor('0').map((a) => a.id)).toEqual(['remove']);

    api().onMenuAction({ action: 'remove', itemId: '0' });
    expect(api().fields().length).toBe(0);
  });

  it('brings a removed field back on undo', () => {
    draw();
    api().removeField('0');
    expect(api().canUndo()).toBe(true);
    api().undoFields();
    expect(api().fields().length).toBe(1);
  });

  it('undoes a placement too, not only a removal', () => {
    draw();
    draw();
    expect(api().fields().length).toBe(2);
    api().undoFields();
    expect(api().fields().length).toBe(1);
  });

  it('moves a field rather than only accepting a new one', () => {
    draw();
    const from = { x: 0.2, y: 0.2, w: 0.2, h: 0.05 };
    api().onGeometryChanged({ id: '0', from, rect: { ...from, x: 0.6 } });
    expect(api().fields()[0].x).toBeCloseTo(0.6);
  });

  it('lists what is on the page, so removal does not need a right-click', () => {
    draw();
    expect(api().fieldsOnPage().length).toBe(1);
    expect(api().fieldsOnPage()[0].id).toBe('0');
  });

  it('offers no menu for an index that is not on this page', () => {
    api().onContextTarget('4');
    expect(api().menuActionsFor('4')).toEqual([]);
  });

  it('colours recipients from the contract palette, not Tailwind indigo', () => {
    // §9 names indigo as forbidden outright, and the first recipient had it.
    expect(api().colorFor('r1')).toBe('#B23A26');
  });

  it('undoes from the keyboard on the step that shows the buttons', () => {
    draw();
    expect(api().fields().length).toBe(1);

    // Step 1 is the recipient list; its bar has no Undo, so a ⌘Z there would
    // be an invisible change to a screen the user is not looking at.
    api().step.set(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    expect(api().fields().length).toBe(1);

    api().step.set(2);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    expect(api().fields().length).toBe(0);
  });
});
