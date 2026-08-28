import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { Annotation } from '../../core/models/models';
import { EditorClipboard } from '../../shared/editor-clipboard.service';
import { NormRect, OverlayMenuAction } from '../../shared/page-overlay/overlay-model';
import { Annotate } from './annotate';

/**
 * Copy, cut, paste, duplicate and the right-click menu in Annotate (phase-12
 * §4.1).
 *
 * The interesting part is geometry: a mark is not always a rectangle, and a
 * copy that moved only `rect` would leave a highlight's quads, an ink stroke's
 * points or a polygon's vertices sitting exactly on top of the original.
 */
describe('Annotate — clipboard, menu and keyboard', () => {
  let fixture: ComponentFixture<Annotate>;
  let annotations: AnnotationsFacade;
  let clipboard: EditorClipboard;

  /** Reach the protected API the template binds to. */
  const api = () => fixture.componentInstance as unknown as {
    page: { set(v: number): void; (): number };
    menuActionsFor(id: string | null): OverlayMenuAction[];
    canPaste(): boolean;
    copySelected(id?: string | null): boolean;
    cutSelected(id?: string | null): boolean;
    pasteHere(): boolean;
    duplicateSelected(id?: string | null): boolean;
    onContextTarget(id: string | null): void;
    onMenuAction(c: { action: string; itemId: string | null }): void;
    onGeometryChanged(c: { id: string; rect: unknown; from: unknown }): void;
    editingId(): string | null;
    pageEditingId(): string | null;
  };

  const square = (over: Partial<Annotation> = {}): Annotation => ({
    id: 's1',
    page: 0,
    type: 'square',
    rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 },
    color: '#332D24',
    ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Annotate],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    annotations = TestBed.inject(AnnotationsFacade);
    annotations.clear();
    clipboard = TestBed.inject(EditorClipboard);
    clipboard.clear();

    fixture = TestBed.createComponent(Annotate);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('pageCount', 3);
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  describe('copy and paste', () => {
    it('pastes a copy with an identity of its own', () => {
      annotations.add(square());
      annotations.select('s1');
      expect(api().copySelected()).toBe(true);

      expect(api().pasteHere()).toBe(true);
      const all = annotations.all();
      expect(all.length).toBe(2);
      expect(all[1].id).not.toBe('s1');
      // Two marks sharing one `/NM` are one annotation the server would update
      // twice, not two annotations.
      expect(new Set(all.map((a) => a.id)).size).toBe(2);
    });

    it('offsets the copy, so two marks do not look like one', () => {
      annotations.add(square());
      api().copySelected('s1');
      api().pasteHere();
      const copy = annotations.all().find((a) => a.id !== 's1')!;
      expect(copy.rect!.x).toBeCloseTo(0.22);
      expect(copy.rect!.y).toBeCloseTo(0.22);
    });

    it('pastes onto the page being looked at, not the page it came from', () => {
      annotations.add(square({ page: 0 }));
      api().copySelected('s1');
      api().page.set(2);
      api().pasteHere();
      expect(annotations.all().find((a) => a.id !== 's1')!.page).toBe(2);
    });

    it('drops the author, because a copy is not a signature', () => {
      // The server stamps the real author; carrying somebody else's name onto a
      // copy is the forgery `isOwn()` already refuses to let anyone edit.
      annotations.add(square({ author: 'Someone Else', created: 'D:20260101000000' }));
      api().copySelected('s1');
      api().pasteHere();
      const copy = annotations.all().find((a) => a.id !== 's1')!;
      expect(copy.author).toBeUndefined();
      expect(copy.created).toBeUndefined();
    });

    it('moves a highlight’s quads together, not its bounding box alone', () => {
      annotations.add(square({
        id: 'h1', type: 'highlight', rect: undefined,
        quads: [
          { x: 0.1, y: 0.1, w: 0.3, h: 0.02 },
          { x: 0.1, y: 0.14, w: 0.2, h: 0.02 },
        ],
      }));
      api().copySelected('h1');
      api().pasteHere();
      const copy = annotations.all().find((a) => a.id !== 'h1')!;
      expect(copy.quads!.length).toBe(2);
      expect(copy.quads![0].x).toBeCloseTo(0.12);
      expect(copy.quads![1].y).toBeCloseTo(0.16);
      // The two lines kept their offset from one another.
      expect(copy.quads![1].y - copy.quads![0].y).toBeCloseTo(0.04);
    });

    it('moves an ink stroke’s points', () => {
      annotations.add(square({
        id: 'i1', type: 'ink', rect: undefined,
        ink: [[[0.1, 0.1], [0.2, 0.3]]],
      }));
      api().copySelected('i1');
      api().pasteHere();
      const copy = annotations.all().find((a) => a.id !== 'i1')!;
      expect(copy.ink![0][0][0]).toBeCloseTo(0.12);
      expect(copy.ink![0][1][1]).toBeCloseTo(0.32);
    });

    it('moves a polygon’s vertices', () => {
      annotations.add(square({
        id: 'p1', type: 'polygon', rect: undefined,
        vertices: [[0.1, 0.1], [0.3, 0.1], [0.2, 0.3]],
      }));
      api().copySelected('p1');
      api().pasteHere();
      const copy = annotations.all().find((a) => a.id !== 'p1')!;
      expect(copy.vertices!.map((p) => p[0])).toEqual(
        [0.12, 0.32, 0.22].map((n) => expect.closeTo(n, 5)),
      );
    });

    it('cut takes the mark away and keeps it on the clipboard', () => {
      annotations.add(square());
      expect(api().cutSelected('s1')).toBe(true);
      expect(annotations.all().length).toBe(0);
      expect(clipboard.has('annotation')).toBe(true);
      api().pasteHere();
      expect(annotations.all().length).toBe(1);
    });

    it('duplicates in one step, without touching the clipboard', () => {
      annotations.add(square());
      clipboard.clear();
      expect(api().duplicateSelected('s1')).toBe(true);
      expect(annotations.all().length).toBe(2);
      expect(clipboard.has('annotation')).toBe(false);
    });

    it('is one undo step per action, so ⌘Z takes back a whole paste', () => {
      annotations.add(square());
      api().copySelected('s1');
      api().pasteHere();
      expect(annotations.all().length).toBe(2);
      annotations.undo();
      expect(annotations.all().length).toBe(1);
    });

    it('does nothing when there is nothing to copy or paste', () => {
      expect(api().copySelected(null)).toBe(false);
      expect(api().pasteHere()).toBe(false);
      expect(api().duplicateSelected(null)).toBe(false);
    });
  });

  describe('the menu', () => {
    it('offers nothing on empty page with an empty clipboard', () => {
      api().onContextTarget(null);
      expect(api().menuActionsFor(null)).toEqual([]);
    });

    it('offers only Paste on empty page once something is copied', () => {
      annotations.add(square());
      api().copySelected('s1');
      api().onContextTarget(null);
      expect(api().menuActionsFor(null).map((a) => a.id)).toEqual(['paste']);
    });

    it('offers Edit text only where there is text on the page to edit', () => {
      annotations.add(square());
      api().onContextTarget('s1');
      expect(api().menuActionsFor('s1').map((a) => a.id)).not.toContain('edit-text');

      annotations.add(square({ id: 't1', type: 'free_text', contents: 'Hi' }));
      api().onContextTarget('t1');
      expect(api().menuActionsFor('t1').map((a) => a.id)).toContain('edit-text');
    });

    it('marks Delete as the dangerous one', () => {
      annotations.add(square());
      api().onContextTarget('s1');
      const del = api().menuActionsFor('s1').find((a) => a.id === 'delete')!;
      expect(del.danger).toBe(true);
    });

    it('selects what was right-clicked, so the menu’s subject is visible', () => {
      annotations.add(square());
      annotations.select(null);
      api().onContextTarget('s1');
      expect(annotations.selectedId()).toBe('s1');
    });

    it('runs its actions on the item the menu belonged to', () => {
      annotations.add(square());
      api().onMenuAction({ action: 'duplicate', itemId: 's1' });
      expect(annotations.all().length).toBe(2);

      api().onMenuAction({ action: 'delete', itemId: 's1' });
      expect(annotations.all().some((a) => a.id === 's1')).toBe(false);
    });

    it('puts the caret in a text box from Edit text', () => {
      annotations.add(square({ id: 't1', type: 'free_text', contents: 'Hi' }));
      api().onMenuAction({ action: 'edit-text', itemId: 't1' });
      expect(api().pageEditingId()).toBe('t1');
    });

    it('opens the sidebar editor from Edit comment', () => {
      annotations.add(square());
      api().onMenuAction({ action: 'edit-comment', itemId: 's1' });
      expect(api().editingId()).toBe('s1');
    });
  });

  /**
   * The palette says what is armed (2026-08-23).
   *
   * Uploading a custom stamp switched the active tool to `image_stamp` and no
   * button lit up — so the one tool with no palette entry was also the only one
   * you could not get back to without uploading the file again.
   */
  describe('the image-stamp entry', () => {
    const realCreate = URL.createObjectURL;
    const button = () =>
      fixture.nativeElement.querySelector('[data-test=tool-image-stamp]') as HTMLButtonElement;

    beforeEach(() => {
      URL.createObjectURL = () => 'blob:stamp';
    });
    afterEach(() => {
      URL.createObjectURL = realCreate;
    });

    it('is there but unusable until a stamp has been uploaded', () => {
      const el = button();
      expect(el).not.toBeNull();
      expect(el.disabled).toBe(true);
      expect(el.getAttribute('aria-pressed')).toBe('false');
      expect(el.title).toBe('Upload a custom stamp below to use this');
      // Nothing to show yet, so no empty image box in a dashed button.
      expect(el.querySelector('img')).toBeNull();
    });

    it('wears the uploaded image and reads as pressed once the tool is armed', () => {
      annotations.useStamp('ref-1', new Blob(['png'], { type: 'image/png' }));
      (fixture.componentInstance as unknown as { tool: { set(v: string): void } })
        .tool.set('image_stamp');
      fixture.detectChanges();

      const el = button();
      expect(el.disabled).toBe(false);
      expect(el.getAttribute('aria-pressed')).toBe('true');
      expect(el.querySelector('img')!.getAttribute('src')).toBe('blob:stamp');
      // Decorative: the button's own words are its name.
      expect(el.querySelector('img')!.getAttribute('alt')).toBe('');
      expect(el.textContent!.trim()).toBe('Image stamp');
    });

    it('re-arms the tool when clicked, which is the way back to it', () => {
      annotations.useStamp('ref-1', new Blob(['png']));
      const tool = fixture.componentInstance as unknown as { tool(): string };
      fixture.detectChanges();
      expect(tool.tool()).toBe('select');

      button().click();
      fixture.detectChanges();

      expect(tool.tool()).toBe('image_stamp');
      expect(button().getAttribute('aria-pressed')).toBe('true');
    });

    it('places the stamp the session is holding', () => {
      annotations.useStamp('ref-1', new Blob(['png']));
      fixture.detectChanges();
      button().click();
      (fixture.componentInstance as unknown as {
        onCreated(d: { page: number; rect: unknown }): void;
      }).onCreated({ page: 0, rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 } });

      const placed = annotations.all();
      expect(placed.length).toBe(1);
      expect(placed[0].type).toBe('image_stamp');
      expect(placed[0].image_ref).toBe('ref-1');
    });

    it('gives every palette entry a hit target and a pressed state', () => {
      // §6: ≥44 px, and a toggle that does not announce its state is a toggle
      // only the sighted half of the audience can read.
      const buttons: HTMLButtonElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('[data-test^=tool-]'),
      );
      expect(buttons.length).toBe(18); // 18 since the Tick box (2026-08-28)
      for (const el of buttons) {
        expect(el.getAttribute('aria-pressed')).not.toBeNull();
        expect(el.className).toContain('min-h-11');
      }
    });
  });

  describe('nudging through the overlay', () => {
    it('re-derives a highlight’s quads rather than only its box', () => {
      annotations.add(square({
        id: 'h1', type: 'highlight', rect: undefined,
        quads: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }],
      }));
      api().onGeometryChanged({
        id: 'h1',
        from: { x: 0.1, y: 0.1, w: 0.3, h: 0.02 },
        rect: { x: 0.15, y: 0.1, w: 0.3, h: 0.02 },
      });
      expect(annotations.all()[0].quads![0].x).toBeCloseTo(0.15);
    });
  });
});

/**
 * Filling a form with text boxes: type in one, draw the next.
 *
 * The flow the 2026-08-26 report described — "every time one field is filled
 * and I go to the next, the previous field disappears or doubles itself". The
 * next box's drawing gesture cancels `pointerdown`, so the box being typed
 * into never blurred; it was torn down uncommitted when `pageEditingId` moved
 * on, and the end-of-editing Chromium then reported for the removed element
 * was read against the *new* box, which was empty, and deleted it. Half the
 * boxes vanished as they were drawn; in a browser that fires nothing for a
 * removed element the typed text was lost instead.
 */
describe('Annotate — filling in fields with text boxes', () => {
  let fixture: ComponentFixture<Annotate>;
  let annotations: AnnotationsFacade;

  const api = () => fixture.componentInstance as unknown as {
    setTool(tool: string): void;
    onCreated(draft: { shape: 'rect'; page: number; rect: NormRect }): void;
    onPageEditingEnded(id: string): void;
    pageEditingId(): string | null;
    undo(): void;
  };

  const html = () => fixture.nativeElement as HTMLElement;
  const editor = () => html().querySelector<HTMLTextAreaElement>('[data-test=overlay-text-editor]');
  const surface = () => html().querySelector<HTMLElement>('[data-test=page-overlay]')!;

  /** Draw a box: the gesture's pointerdown on the page, then the created draft. */
  function drawBox(index: number): void {
    surface().dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: 10, clientY: 10, button: 0,
    }));
    api().onCreated({ shape: 'rect', page: 0, rect: { x: 0.1, y: 0.2 + index * 0.05, w: 0.5, h: 0.03 } });
    fixture.detectChanges();
  }

  function type(text: string): void {
    const box = editor()!;
    box.value = text;
    box.dispatchEvent(new Event('input'));
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Annotate],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    annotations = TestBed.inject(AnnotationsFacade);
    annotations.clear();
    fixture = TestBed.createComponent(Annotate);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('pageCount', 2);
    fixture.detectChanges();
    api().setTool('free_text');
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('keeps every box and every word when the next box is drawn straight after typing', () => {
    drawBox(0);
    expect(editor()).toBeTruthy();
    type('Yuval Haspel');

    drawBox(1);
    type('Tel Aviv');

    drawBox(2);
    type('Bank Hapoalim');
    editor()!.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    const texts = annotations.all().map((a) => a.contents);
    expect(texts).toEqual(['Yuval Haspel', 'Tel Aviv', 'Bank Hapoalim']);
    expect(html().querySelectorAll('[data-test=overlay-text]').length).toBe(3);
    expect(editor()).toBeNull();
    expect(api().pageEditingId()).toBeNull();
  });

  it('opens the caret in the new box, and only the new box', () => {
    drawBox(0);
    type('First');
    drawBox(1);
    const boxes = annotations.all();
    expect(boxes.length).toBe(2);
    expect(editor()?.dataset['itemId']).toBe(boxes[1].id);
    expect(api().pageEditingId()).toBe(boxes[1].id);
    expect(html().querySelectorAll('[data-test=overlay-text-editor]').length).toBe(1);
  });

  it('still drops a box that was left empty, and only that one', () => {
    drawBox(0);            // never typed into
    drawBox(1);
    expect(annotations.all().length).toBe(1);
    expect(api().pageEditingId()).toBe(annotations.all()[0].id);
  });

  it('judges an end-of-editing by the id it names, not by what is being edited now', () => {
    drawBox(0);
    type('Kept');
    drawBox(1);
    const [first, second] = annotations.all();
    // A late report for the first box (a browser firing blur for a removed
    // element) must neither close nor delete the second.
    api().onPageEditingEnded(first.id);
    fixture.detectChanges();
    expect(api().pageEditingId()).toBe(second.id);
    expect(annotations.all().map((a) => a.id)).toEqual([first.id, second.id]);
  });

  describe('a box is never shorter than one line of its type', () => {
    // A4 fallback (595 × 842 pt) at the 900 px desk width: 12 pt is 18.15 px,
    // one 1.25 line is 23 whole px, plus the two 1 px insets → 25 px of a
    // 1273.6 px page.
    const fontPx = (12 / 595) * 900;
    const oneLine = (Math.ceil(fontPx * 1.25) + 2) / ((900 * 842) / 595);

    it('grows a drag thinner than a line upwards — the words sit on the traced line', () => {
      api().onCreated({ shape: 'rect', page: 0, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.005 } });
      const [box] = annotations.all();
      expect(box.rect!.h).toBeCloseTo(oneLine, 6);
      // The bottom edge stays where the drag ended; the top moves up.
      expect(box.rect!.y + box.rect!.h).toBeCloseTo(0.205, 6);
      expect(box.rect!.x).toBeCloseTo(0.1, 6);
      expect(box.rect!.w).toBeCloseTo(0.5, 6);
    });

    it('leaves a drag that was already tall enough exactly as drawn', () => {
      api().onCreated({ shape: 'rect', page: 0, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.08 } });
      expect(annotations.all()[0].rect).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.08 });
    });

    it('measures the line at the current zoom, so a phone-width page is not a pixel short', () => {
      // At 437 px the same 12 pt is 8.8 px; 1.25 of it is 11.02 → 12 whole px
      // + 2 insets = 14 px of a 618.4 px page — a larger fraction than at 900.
      (fixture.componentInstance as unknown as { onFit(available: number): void }).onFit(437);
      api().onCreated({ shape: 'rect', page: 0, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.005 } });
      const expected = (Math.ceil((12 / 595) * 437 * 1.25) + 2) / ((437 * 842) / 595);
      expect(annotations.all()[0].rect!.h).toBeCloseTo(expected, 6);
      expect(expected).toBeGreaterThan(oneLine);
    });

    it('stays on the page when the drag hugs the top edge', () => {
      api().onCreated({ shape: 'rect', page: 0, rect: { x: 0.1, y: 0.001, w: 0.5, h: 0.004 } });
      const rect = annotations.all()[0].rect!;
      expect(rect.h).toBeCloseTo(oneLine, 6);
      expect(rect.y).toBeGreaterThanOrEqual(0);
    });
  });

  it('commits one history entry per sentence, and undo still takes back a sentence', () => {
    drawBox(0);
    type('One');
    drawBox(1);
    type('Two');
    editor()!.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    // add, commit, add, commit — four steps back to an empty page.
    expect(annotations.all().map((a) => a.contents)).toEqual(['One', 'Two']);
    api().undo();
    expect(annotations.all().map((a) => a.contents)).toEqual(['One', '']);
    api().undo();
    expect(annotations.all().map((a) => a.contents)).toEqual(['One']);
    api().undo();
    expect(annotations.all().map((a) => a.contents)).toEqual(['']);
    api().undo();
    expect(annotations.all()).toEqual([]);
    expect(annotations.canUndo()).toBe(false);
  });
});
