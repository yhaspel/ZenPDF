import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OverlayDraft, OverlayItem } from './overlay-model';
import { PageOverlay } from './page-overlay';

/**
 * The norm↔screen mapping (§8) and the gestures built on it.
 *
 * `overlay-model.spec.ts` covers the pure helpers; this covers the component
 * that turns pointer pixels into normalized geometry and back — the part that
 * has to stay correct at every zoom level, since nothing stores a pixel.
 */
describe('PageOverlay', () => {
  let fixture: ComponentFixture<PageOverlay>;
  let overlay: PageOverlay;

  /** Reach the protected surface API the template binds to. */
  const api = () => overlay as unknown as {
    px(v: number): number;
    pyv(v: number): number;
    strokePx(item: OverlayItem): number;
    boxHeight(): number;
    aspect: { set(v: number): void };
    onKeyDown(e: KeyboardEvent): void;
    pending: { set(v: [number, number][]): void; (): [number, number][] };
    drag: { (): unknown; set(v: unknown): void };
    finishPending(): void;
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('renderWidth', 600);
    overlay = fixture.componentInstance;
    fixture.detectChanges();
  });

  describe('normalized → screen', () => {
    it('scales x by the render width', () => {
      expect(api().px(0)).toBe(0);
      expect(api().px(0.5)).toBe(300);
      expect(api().px(1)).toBe(600);
    });

    it('scales y by the page box height, not the width', () => {
      // A4 aspect: 600 wide → 849 tall.
      api().aspect.set(842 / 595);
      expect(api().boxHeight()).toBe(849);
      expect(api().pyv(0.5)).toBeCloseTo(424.5, 0);
    });

    it('is zoom-independent: the same fraction tracks the page at any width', () => {
      const atSix = api().px(0.25);
      fixture.componentRef.setInput('renderWidth', 1200);
      fixture.detectChanges();
      expect(api().px(0.25)).toBeCloseTo(atSix * 2, 5);
    });

    it('scales stroke width from PDF points, with a 1px floor', () => {
      // 595pt page rendered 600px wide ≈ 1:1, so a 2pt stroke is about 2px.
      expect(api().strokePx({ id: 'a', page: 0, shape: 'rect', width: 2 })).toBeCloseTo(2, 0);
      // Doubling the zoom doubles the stroke, or a hairline would vanish.
      fixture.componentRef.setInput('renderWidth', 1200);
      fixture.detectChanges();
      expect(api().strokePx({ id: 'a', page: 0, shape: 'rect', width: 2 })).toBeCloseTo(4, 0);
      // …but a sub-pixel stroke still renders.
      expect(api().strokePx({ id: 'a', page: 0, shape: 'rect', width: 0 })).toBe(1);
    });
  });

  describe('keyboard', () => {
    it('ESC abandons a half-drawn polygon before it clears the selection', () => {
      const cleared: (string | null)[] = [];
      overlay.selectionChanged.subscribe((id) => cleared.push(id));
      api().pending.set([[0.1, 0.1], [0.2, 0.2]]);

      api().onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(api().pending()).toEqual([]);
      // First ESC drops the in-progress shape only — it does not also deselect.
      expect(cleared).toEqual([]);

      api().onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(cleared).toEqual([null]);
    });

    it('Delete removes the selected item', () => {
      const deleted: string[] = [];
      overlay.deleteRequested.subscribe((id) => deleted.push(id));
      fixture.componentRef.setInput('selectedId', 'item-9');
      fixture.detectChanges();

      api().onKeyDown(new KeyboardEvent('keydown', { key: 'Delete' }));
      expect(deleted).toEqual(['item-9']);
    });

    it('Delete does nothing with no selection', () => {
      const deleted: string[] = [];
      overlay.deleteRequested.subscribe((id) => deleted.push(id));
      api().onKeyDown(new KeyboardEvent('keydown', { key: 'Delete' }));
      expect(deleted).toEqual([]);
    });

    it('Enter closes a polygon, and only when it has enough points', () => {
      const drafts: OverlayDraft[] = [];
      overlay.created.subscribe((d) => drafts.push(d));
      fixture.componentRef.setInput('tool', 'polygon');
      fixture.detectChanges();

      api().pending.set([[0.1, 0.1], [0.2, 0.2]]);
      api().onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(drafts).toEqual([]); // two points is a line, not a polygon

      api().pending.set([[0.1, 0.1], [0.2, 0.2], [0.15, 0.3]]);
      api().onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(drafts.length).toBe(1);
      expect(drafts[0].shape).toBe('polygon');
      expect(drafts[0].points?.length).toBe(3);
    });
  });

  describe('read-only mode', () => {
    it('emits nothing on a pointer down', () => {
      const drafts: OverlayDraft[] = [];
      overlay.created.subscribe((d) => drafts.push(d));
      fixture.componentRef.setInput('readonlyMode', true);
      fixture.componentRef.setInput('tool', 'rect');
      fixture.detectChanges();

      (overlay as unknown as { onPointerDown(e: PointerEvent): void }).onPointerDown(
        new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }),
      );
      expect(drafts).toEqual([]);
      expect(api().drag()).toBeNull();
    });
  });
});
