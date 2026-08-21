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

/**
 * The right-click menu, the primary-button guard and arrow-key nudging
 * (phase-12 §3).
 *
 * The guard is the load-bearing one. `pointerdown` fires *before*
 * `contextmenu`, so before this existed a right-click ran the entire left-click
 * path first — which in Protect, where selecting an area removed it, deleted
 * the thing the user was trying to open a menu on.
 */
describe('PageOverlay — menu, guard and nudge', () => {
  let fixture: ComponentFixture<PageOverlay>;
  let overlay: PageOverlay;

  const item = (over: Partial<OverlayItem> = {}): OverlayItem => ({
    id: 'a1',
    page: 0,
    shape: 'rect',
    rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
    ...over,
  });

  const inner = () => overlay as unknown as {
    onKeyDown(e: KeyboardEvent): void;
    onMenuKeyDown(e: KeyboardEvent): void;
    onPointerDown(e: PointerEvent): void;
    onItemPointerDown(e: PointerEvent, i: OverlayItem): void;
    onContextMenu(e: MouseEvent): void;
    chooseMenuAction(a: { id: string; label: string; disabled?: boolean }): void;
    menu(): { x: number; y: number; itemId: string | null } | null;
    menuIndex(): number;
    liveMessage(): string;
    drag(): unknown;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('renderWidth', 600);
    fixture.componentRef.setInput('tool', 'select');
    fixture.componentRef.setInput('items', [item()]);
    overlay = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function rightClick(): MouseEvent {
    const event = new MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    host().dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  describe('the primary-button guard', () => {
    it('does not select, deselect or start a drag on a right-click', () => {
      const selections: (string | null)[] = [];
      overlay.selectionChanged.subscribe((id) => selections.push(id));

      inner().onPointerDown(new PointerEvent('pointerdown', { button: 2 }));
      inner().onItemPointerDown(new PointerEvent('pointerdown', { button: 2 }), item());

      expect(selections).toEqual([]);
      expect(inner().drag()).toBeNull();
    });

    it('still does all of that on a left-click', () => {
      const selections: (string | null)[] = [];
      overlay.selectionChanged.subscribe((id) => selections.push(id));
      const event = new PointerEvent('pointerdown', { button: 0 });
      Object.defineProperty(event, 'target', { value: document.createElement('div') });
      inner().onItemPointerDown(event, item());
      expect(selections).toEqual(['a1']);
    });
  });

  describe('opening', () => {
    it('reports what is under the pointer, then opens the menu', () => {
      const targets: (string | null)[] = [];
      overlay.contextTarget.subscribe((id) => targets.push(id));
      fixture.componentRef.setInput('menuActionsFor', () => [{ id: 'delete', label: 'Delete' }]);
      fixture.detectChanges();

      const event = rightClick();
      expect(targets).toEqual(['a1']);
      expect(event.defaultPrevented).toBe(true);
      expect(host().querySelector('[data-test=overlay-menu]')).toBeTruthy();
      expect(inner().menu()?.itemId).toBe('a1');
    });

    it('leaves the browser’s own menu alone when there is nothing to offer', () => {
      const targets: (string | null)[] = [];
      overlay.contextTarget.subscribe((id) => targets.push(id));
      const event = rightClick();

      expect(targets).toEqual(['a1']); // the feature still hears about it
      expect(event.defaultPrevented).toBe(false);
      expect(host().querySelector('[data-test=overlay-menu]')).toBeNull();
    });

    it('offers nothing at all on a locked item', () => {
      // A locked item is rendered `pointer-events: none`, so the event lands on
      // the surface — hit-testing by ancestry would report "empty page" and
      // offer *Paste* over a redaction match. Geometry does not lie.
      const targets: (string | null)[] = [];
      overlay.contextTarget.subscribe((id) => targets.push(id));
      fixture.componentRef.setInput('items', [item({ locked: true })]);
      fixture.componentRef.setInput('menuActionsFor', () => [{ id: 'delete', label: 'Delete' }]);
      fixture.detectChanges();

      rightClick();
      expect(targets).toEqual([]);
      expect(host().querySelector('[data-test=overlay-menu]')).toBeNull();
    });

    it('reports empty page when the pointer is on nothing', () => {
      const targets: (string | null)[] = [];
      overlay.contextTarget.subscribe((id) => targets.push(id));
      fixture.componentRef.setInput('items', [item({ rect: { x: 0.8, y: 0.8, w: 0.1, h: 0.1 } })]);
      fixture.detectChanges();
      rightClick();
      expect(targets).toEqual([null]);
    });

    it('opens from the keyboard, anchored on the selection', () => {
      fixture.componentRef.setInput('selectedId', 'a1');
      fixture.componentRef.setInput('menuActionsFor', () => [{ id: 'delete', label: 'Delete' }]);
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, cancelable: true });
      inner().onKeyDown(event);
      fixture.detectChanges();
      expect(inner().menu()).toBeTruthy();
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('the menu’s keyboard', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('menuActionsFor', () => [
        { id: 'copy', label: 'Copy' },
        { id: 'paste', label: 'Paste', disabled: true },
        { id: 'delete', label: 'Delete', danger: true },
      ]);
      fixture.detectChanges();
      rightClick();
    });

    it('marks unavailable entries with aria-disabled, not the native attribute', () => {
      // A natively disabled button drops out of the accessibility tree, so
      // "Paste (unavailable)" would vanish instead of reading as unavailable.
      const paste = host().querySelector('[data-test=overlay-menu-paste]') as HTMLButtonElement;
      expect(paste.getAttribute('aria-disabled')).toBe('true');
      expect(paste.disabled).toBe(false);
    });

    it('walks past the disabled entry rather than landing on it', () => {
      expect(inner().menuIndex()).toBe(0);
      inner().onMenuKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
      expect(inner().menuIndex()).toBe(2);
      inner().onMenuKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
      expect(inner().menuIndex()).toBe(0);
    });

    it('jumps with Home and End', () => {
      inner().onMenuKeyDown(new KeyboardEvent('keydown', { key: 'End', cancelable: true }));
      expect(inner().menuIndex()).toBe(2);
      inner().onMenuKeyDown(new KeyboardEvent('keydown', { key: 'Home', cancelable: true }));
      expect(inner().menuIndex()).toBe(0);
    });

    it('keeps a roving tabindex so Tab cannot wander into the middle of it', () => {
      const buttons = host().querySelectorAll<HTMLButtonElement>('[role=menuitem]');
      expect(buttons[0].getAttribute('tabindex')).toBe('0');
      expect(buttons[1].getAttribute('tabindex')).toBe('-1');
    });

    it('activates on Enter and reports the item the menu belonged to', () => {
      const chosen: { action: string; itemId: string | null }[] = [];
      overlay.menuAction.subscribe((c) => chosen.push(c));
      inner().onMenuKeyDown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
      expect(chosen).toEqual([{ action: 'copy', itemId: 'a1' }]);
      expect(inner().menu()).toBeNull();
    });

    it('refuses to activate a disabled entry', () => {
      const chosen: { action: string }[] = [];
      overlay.menuAction.subscribe((c) => chosen.push(c));
      inner().chooseMenuAction({ id: 'paste', label: 'Paste', disabled: true });
      expect(chosen).toEqual([]);
    });

    it('closes on Escape without also clearing the selection', () => {
      const selections: (string | null)[] = [];
      overlay.selectionChanged.subscribe((id) => selections.push(id));
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      inner().onMenuKeyDown(event);
      expect(inner().menu()).toBeNull();
      expect(selections).toEqual([]);
      expect(event.defaultPrevented).toBe(true);
    });

    it('closes on Tab, so focus cannot leave a menu still on screen', () => {
      inner().onMenuKeyDown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
      expect(inner().menu()).toBeNull();
    });

    it('owns the keyboard entirely while it is open', () => {
      // Otherwise ↓ to walk the menu would also nudge the shape under it, and
      // Delete to reach an entry would destroy the item the menu belongs to.
      const deleted: string[] = [];
      const moved: unknown[] = [];
      overlay.deleteRequested.subscribe((id) => deleted.push(id));
      overlay.geometryChanged.subscribe((c) => moved.push(c));
      fixture.componentRef.setInput('selectedId', 'a1');
      fixture.detectChanges();

      inner().onKeyDown(new KeyboardEvent('keydown', { key: 'Delete', cancelable: true }));
      inner().onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
      expect(deleted).toEqual([]);
      expect(moved).toEqual([]);
    });
  });

  describe('nudging', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('items', [item({ rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } })]);
      fixture.componentRef.setInput('selectedId', 'a1');
      fixture.detectChanges();
    });

    it('moves the selection through the same channel a drag uses', () => {
      const moves: { rect: { x: number; y: number } }[] = [];
      overlay.geometryChanged.subscribe((c) => moves.push(c));
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      inner().onKeyDown(event);

      expect(moves.length).toBe(1);
      expect(moves[0].rect.x).toBeCloseTo(0.4025);
      expect(event.defaultPrevented).toBe(true);
    });

    it('goes ten times as far with Shift', () => {
      const moves: { rect: { x: number; y: number } }[] = [];
      overlay.geometryChanged.subscribe((c) => moves.push(c));
      inner().onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, cancelable: true }));
      expect(moves[0].rect.y).toBeCloseTo(0.425);
    });

    it('goes left on ArrowLeft, in any writing direction', () => {
      const moves: { rect: { x: number } }[] = [];
      overlay.geometryChanged.subscribe((c) => moves.push(c));
      inner().onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
      expect(moves[0].rect.x).toBeCloseTo(0.3975);
    });

    it('stops at the edge, and still swallows the key so the pane holds still', () => {
      fixture.componentRef.setInput('items', [item({ rect: { x: 0.8, y: 0.4, w: 0.2, h: 0.1 } })]);
      fixture.detectChanges();
      const moves: unknown[] = [];
      overlay.geometryChanged.subscribe((c) => moves.push(c));

      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      inner().onKeyDown(event);
      expect(moves).toEqual([]);
      expect(event.defaultPrevented).toBe(true);
      expect(inner().liveMessage()).toBe('At the edge of the page');
    });

    it('leaves the arrows to the scrolling pane when nothing is selected', () => {
      fixture.componentRef.setInput('selectedId', null);
      fixture.detectChanges();
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      inner().onKeyDown(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it('does not move an item whose handles are switched off', () => {
      // Edit mode's items are read-models of the file; they cannot be moved.
      fixture.componentRef.setInput('readonlyHandles', true);
      fixture.detectChanges();
      const moves: unknown[] = [];
      overlay.geometryChanged.subscribe((c) => moves.push(c));
      inner().onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
      expect(moves).toEqual([]);
    });

    it('says out loud where the selection went', () => {
      inner().onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
      expect(inner().liveMessage()).toBe('Moved up');
      fixture.detectChanges();
      expect(host().querySelector('[data-test=overlay-live]')?.textContent).toContain('Moved up');
    });
  });

  describe('the host itself', () => {
    it('names what it is, so a focusable operable element is not anonymous', () => {
      expect(host().getAttribute('role')).toBe('group');
      expect(host().getAttribute('aria-label')).toBe('Page 1 — page editing layer');
      expect(host().getAttribute('tabindex')).toBe('0');
    });

    it('announces a selection, which is otherwise a silent pointer gesture', () => {
      fixture.componentRef.setInput('items', [item({ shape: 'ellipse' })]);
      fixture.componentRef.setInput('selectedId', 'a1');
      fixture.detectChanges();
      expect(inner().liveMessage()).toBe('Ellipse selected');
    });

    it('hides the resize grips when handles are switched off', () => {
      fixture.componentRef.setInput('selectedId', 'a1');
      fixture.detectChanges();
      expect(host().querySelectorAll('[data-test=overlay-handle]').length).toBe(4);

      fixture.componentRef.setInput('readonlyHandles', true);
      fixture.detectChanges();
      expect(host().querySelectorAll('[data-test=overlay-handle]').length).toBe(0);
    });
  });
});

/**
 * One announcement per thing that happened.
 *
 * A nudge replaces the selected item object, so a selection effect keyed on the
 * item rather than its id re-announced "Rectangle selected" on every arrow
 * press — wiping out "Moved right" before a screen reader could read it.
 */
describe('PageOverlay — the live region does not talk over itself', () => {
  it('keeps the nudge announcement after the item object changes', () => {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('renderWidth', 600);
    fixture.componentRef.setInput('items', [
      { id: 'a1', page: 0, shape: 'rect' as const, rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } },
    ]);
    fixture.componentRef.setInput('selectedId', 'a1');
    fixture.detectChanges();

    const inner = fixture.componentInstance as unknown as {
      onKeyDown(e: KeyboardEvent): void;
      liveMessage(): string;
    };
    expect(inner.liveMessage()).toBe('Rectangle selected');

    inner.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    // The consumer answers a nudge by handing back a new item object.
    fixture.componentRef.setInput('items', [
      { id: 'a1', page: 0, shape: 'rect' as const, rect: { x: 0.4025, y: 0.4, w: 0.2, h: 0.1 } },
    ]);
    fixture.detectChanges();

    expect(inner.liveMessage()).toBe('Moved right');
    TestBed.resetTestingModule();
  });
});

/**
 * The menu's action list is resolved *synchronously*, inside the event.
 *
 * This is the regression test for an afternoon's bug. With an array input, the
 * overlay emitted `contextTarget`, the feature set a signal, and the overlay
 * then read an input that Angular had not refreshed yet — so it saw the
 * *previous* item's actions. Where the previous list was empty (Protect, on the
 * first right-click of a session) it decided there was nothing to offer and
 * never opened at all. A browser found it; no unit test did, because a fixture
 * runs change detection between steps and papers over exactly this gap.
 */
describe('PageOverlay — the menu resolves its actions in the event', () => {
  it('asks for the actions of the item under the pointer, and uses the answer at once', () => {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('renderWidth', 600);
    fixture.componentRef.setInput('items', [
      { id: 'a1', page: 0, shape: 'rect' as const, rect: { x: 0, y: 0, w: 1, h: 1 } },
    ]);

    const askedFor: (string | null)[] = [];
    fixture.componentRef.setInput('menuActionsFor', (id: string | null) => {
      askedFor.push(id);
      return id ? [{ id: 'remove', label: 'Remove' }] : [];
    });
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const event = new MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    host.dispatchEvent(event);

    // Decided before any change detection ran.
    expect(askedFor).toEqual(['a1']);
    expect(event.defaultPrevented).toBe(true);

    fixture.detectChanges();
    expect(host.querySelector('[data-test=overlay-menu-remove]')).toBeTruthy();
    TestBed.resetTestingModule();
  });

  it('leaves the browser’s menu alone when the resolver returns nothing', () => {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('menuActionsFor', () => []);
    fixture.detectChanges();

    const event = new MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    (fixture.nativeElement as HTMLElement).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    TestBed.resetTestingModule();
  });
});

/**
 * A click is a zero-distance drag, and it is not a change.
 *
 * `onItemPointerDown` starts a `move` drag on every selecting click, so without
 * this guard each one reported a geometry change with identical coordinates —
 * a history entry for nothing, which made the first ⌘Z after selecting a shape
 * appear to do nothing at all.
 */
describe('PageOverlay — a click is not a move', () => {
  it('reports nothing when the pointer went nowhere', () => {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('renderWidth', 600);
    fixture.detectChanges();

    const moves: unknown[] = [];
    fixture.componentInstance.geometryChanged.subscribe((c) => moves.push(c));
    const inner = fixture.componentInstance as unknown as {
      drag: { set(v: unknown): void };
      onPointerUp(e: PointerEvent): void;
    };
    // jsdom reports a zero-size box, so `toNorm` always answers [0, 0]; a drag
    // that *started* there is therefore the zero-distance case.
    const rect = { x: 0.2, y: 0.2, w: 0.2, h: 0.1 };
    inner.drag.set({
      kind: 'move', start: [0, 0], current: [0, 0], itemId: 'a1', originRect: rect,
    });
    inner.onPointerUp(new PointerEvent('pointerup'));
    expect(moves).toEqual([]);

    // A real drag still reports.
    inner.drag.set({
      kind: 'move', start: [0.3, 0.3], current: [0, 0], itemId: 'a1', originRect: rect,
    });
    inner.onPointerUp(new PointerEvent('pointerup'));
    expect(moves.length).toBe(1);
    TestBed.resetTestingModule();
  });
});
