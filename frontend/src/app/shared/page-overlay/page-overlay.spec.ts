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

/**
 * Text drawn on the page, not in a badge above it.
 *
 * A text box whose words only appeared in a 10px chip — truncated at 24
 * characters, with the box itself left empty — is the defect this covers: the
 * words go in the box, at the size and colour the file will use, and the box
 * is where they are edited.
 */
describe('PageOverlay — text on the page', () => {
  let fixture: ComponentFixture<PageOverlay>;

  const textItem = (over: Partial<OverlayItem> = {}): OverlayItem => ({
    id: 'a1',
    page: 0,
    shape: 'rect',
    rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 },
    text: 'Hello on the page',
    fontSize: 24,
    textColor: '#332D24',
    ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('renderWidth', 595);
    fixture.detectChanges();
  });

  function html(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the whole text inside the item, not a truncated badge', () => {
    fixture.componentRef.setInput('items', [textItem({
      text: 'A sentence comfortably longer than twenty-four characters.',
    })]);
    fixture.detectChanges();

    const drawn = html().querySelector('[data-test=overlay-text]');
    expect(drawn?.textContent).toBe('A sentence comfortably longer than twenty-four characters.');
    expect(html().querySelector('[data-test=overlay-label]')).toBeNull();
  });

  it('converts the point size against the page width, at any zoom', () => {
    fixture.componentRef.setInput('items', [textItem()]);
    fixture.detectChanges();
    const at595 = (html().querySelector('[data-test=overlay-text]') as HTMLElement).style.fontSize;
    // 24pt on a 595pt page rendered 595px wide is 24px.
    expect(at595).toBe('24px');

    fixture.componentRef.setInput('renderWidth', 1190);
    fixture.detectChanges();
    const at1190 = (html().querySelector('[data-test=overlay-text]') as HTMLElement).style.fontSize;
    expect(at1190).toBe('48px');
  });

  it('honours the page it is actually measuring', () => {
    fixture.componentRef.setInput('items', [textItem()]);
    // A page twice as wide in points draws the same point size half as large.
    fixture.componentRef.setInput('pageWidthPt', 1190);
    fixture.detectChanges();
    expect((html().querySelector('[data-test=overlay-text]') as HTMLElement).style.fontSize)
      .toBe('12px');
  });

  it('swaps the drawn text for an editor on the item being edited', () => {
    fixture.componentRef.setInput('items', [textItem()]);
    fixture.componentRef.setInput('editingId', 'a1');
    fixture.detectChanges();

    const editor = html().querySelector<HTMLTextAreaElement>('[data-test=overlay-text-editor]');
    expect(editor).toBeTruthy();
    expect(editor!.value).toBe('Hello on the page');
    expect(html().querySelector('[data-test=overlay-text]')).toBeNull();
  });

  it('commits once, on blur — so one undo takes back a sentence', () => {
    fixture.componentRef.setInput('items', [textItem()]);
    fixture.componentRef.setInput('editingId', 'a1');
    fixture.detectChanges();

    const changes: { id: string; text: string }[] = [];
    let ended = 0;
    fixture.componentInstance.textChanged.subscribe((c) => changes.push(c));
    fixture.componentInstance.editingEnded.subscribe(() => (ended += 1));

    const editor = html().querySelector<HTMLTextAreaElement>('[data-test=overlay-text-editor]')!;
    editor.value = 'Typed';
    editor.dispatchEvent(new Event('input'));
    expect(changes).toEqual([]);

    editor.dispatchEvent(new Event('blur'));
    expect(changes).toEqual([{ id: 'a1', text: 'Typed' }]);
    expect(ended).toBe(1);
  });

  it('does not offer an editor in read-only mode', () => {
    fixture.componentRef.setInput('items', [textItem()]);
    fixture.componentRef.setInput('editingId', 'a1');
    fixture.componentRef.setInput('readonlyMode', true);
    fixture.detectChanges();
    expect(html().querySelector('[data-test=overlay-text-editor]')).toBeNull();
    expect(html().querySelector('[data-test=overlay-text]')).toBeTruthy();
  });

  it('asks to edit on a double-click, but only with the select tool', () => {
    fixture.componentRef.setInput('items', [textItem()]);
    fixture.componentRef.setInput('tool', 'rect');
    fixture.detectChanges();
    const asked: string[] = [];
    fixture.componentInstance.editRequested.subscribe((id) => asked.push(id));

    const group = html().querySelector('[data-test=overlay-item]')!;
    group.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(asked).toEqual([]);

    fixture.componentRef.setInput('tool', 'select');
    fixture.detectChanges();
    group.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(asked).toEqual(['a1']);
  });
});
