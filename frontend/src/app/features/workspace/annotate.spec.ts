import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { Annotation } from '../../core/models/models';
import { EditorClipboard } from '../../shared/editor-clipboard.service';
import { OverlayMenuAction } from '../../shared/page-overlay/overlay-model';
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
