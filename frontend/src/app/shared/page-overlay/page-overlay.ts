import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { DocumentsService } from '../../core/services/documents.service';
import {
  NUDGE_SHIFT_MULTIPLIER,
  NUDGE_STEP,
  NUDGE_VECTORS,
  resolveShortcut,
} from '../shortcuts';
import {
  NormPoint,
  NormRect,
  OverlayDraft,
  OverlayGeometryChange,
  OverlayItem,
  OverlayMenuAction,
  OverlayTool,
  OverlayWord,
  clamp01,
  normalizeRect,
  nudgeRect,
  quadsFromWords,
  smoothStroke,
} from './overlay-model';

type Handle = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Enough of the menu's size to keep it inside the page before it has rendered.
 *
 * Measuring it would need a frame, and a menu that appears in the wrong place
 * and then jumps is worse than one placed from a known minimum: `.menu` is
 * `min-width: 160px` with 4px of padding, and its items are 44px tall.
 */
const MENU_MIN_WIDTH = 200;
const MENU_ITEM_HEIGHT = 44;
const MENU_PADDING = 8;

/** Two rects the user cannot tell apart — a sub-0.01% difference is a click. */
function sameRect(a: NormRect, b: NormRect): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-4;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
}

/** What a shape is called out loud. `OverlayItem.label`, where a feature set
 *  one, is a better name than any of these and wins. */
const SHAPE_NAMES: Record<string, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  polygon: 'Polygon',
  polyline: 'Polyline',
  ink: 'Drawing',
  quads: 'Text markup',
  point: 'Note',
};

/** What a nudge is called out loud. */
const NUDGE_NAMES: Record<string, string> = {
  'nudge-up': 'up',
  'nudge-down': 'down',
  'nudge-left': 'left',
  'nudge-right': 'right',
};

/** Where the context menu is, and what it belongs to. */
interface MenuState {
  x: number;
  y: number;
  itemId: string | null;
}

interface Drag {
  kind: 'draw' | 'move' | 'resize' | 'ink' | 'select-text';
  start: NormPoint;
  current: NormPoint;
  itemId?: string;
  handle?: Handle;
  originRect?: NormRect;
  stroke?: NormPoint[];
}

/**
 * The overlay interaction layer (01-architecture.md §7, phase-03 "Overlay layer v2").
 *
 * A positioned stack over one rendered page: the page raster, an optional
 * transparent text layer, an SVG shape layer, and drag handles. Built once here
 * and reused by phases 4/5/7/8 — it is deliberately ignorant of annotations,
 * form fields or redaction; it emits *shapes* and renders `OverlayItem`s.
 *
 * Why a server-rendered page raster rather than drawing on PDF.js's canvas: the
 * viewer owns its DOM and re-creates it on every scroll/zoom, so anchoring to it
 * means fighting for layout on every frame. Rendering the page ourselves makes
 * the overlay's coordinate space exactly the element's box — which is what makes
 * normalized geometry (§8) hold with no conversion at all.
 */
@Component({
  selector: 'app-page-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './page-overlay.html',
  host: {
    '(keydown)': 'onKeyDown($event)',
    '(contextmenu)': 'onContextMenu($event)',
    tabindex: '0',
    role: 'group',
    '[attr.aria-label]': "'Page ' + (page() + 1) + ' — page editing layer'",
    class: 'relative block outline-none',
  },
})
export class PageOverlay {
  readonly docId = input.required<string>();
  readonly page = input(0);
  readonly version = input<number | undefined>(undefined);
  /** Raster width in CSS pixels. Geometry is normalized, so this is pure zoom. */
  readonly renderWidth = input(900);
  readonly items = input<OverlayItem[]>([]);
  readonly tool = input<OverlayTool>('select');
  readonly words = input<OverlayWord[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly readonlyMode = input(false);
  /**
   * The page's width in PDF points, so a point size becomes the right number
   * of pixels. 595 (A4) is the fallback for the moment before the page's own
   * measurements have been fetched — being 3% out on a Letter page for one
   * frame is invisible; guessing pixels for points is not.
   */
  readonly pageWidthPt = input(595);
  /** Which item is being typed into, if any. */
  readonly editingId = input<string | null>(null);
  /**
   * Draw the selection outline without resize grips.
   *
   * Edit mode's items are read-models of the file — text blocks, images, links
   * — and cannot be moved by dragging a corner. Rendering four live handles
   * over them would be a control wired to nothing, which the design contract
   * forbids outright (§10, "no dead UI").
   */
  readonly readonlyHandles = input(false);
  /**
   * What the right-click menu should offer for whatever is under the pointer.
   *
   * A **function**, not an array, and that is load-bearing. The overlay has to
   * decide *synchronously* — inside the `contextmenu` handler — whether to
   * `preventDefault()` and open, because a browser menu cannot be suppressed
   * after the fact. An array input cannot answer that question: emitting
   * `contextTarget` sets a signal in the parent, but the input carrying the
   * result only updates on the next change detection, so the overlay would read
   * the *previous* item's actions. That mistake shipped for an afternoon and
   * showed up as "the redaction menu never opens" while Annotate's worked by
   * luck, because its list happened to be non-empty already.
   *
   * The overlay still owns opening, placing, navigating and dismissing; what an
   * entry *means* stays with the feature, the same way `OverlayItem.data` keeps
   * feature semantics out of here. **An empty list means no menu** — the
   * browser's own is left alone rather than replaced with an empty box.
   */
  readonly menuActionsFor = input<(itemId: string | null) => OverlayMenuAction[]>(() => []);
  /** Stroke/fill applied to the in-progress shape, so drawing previews truthfully. */
  /** The in-progress shape's colour. Vermilion by default — every call site
   *  overrides it, and the contract has no rose. */
  readonly drawStroke = input('#B23A26');
  readonly drawFill = input<string | null>(null);
  readonly drawWidth = input(2);

  readonly created = output<OverlayDraft>();
  readonly geometryChanged = output<OverlayGeometryChange>();
  readonly selectionChanged = output<string | null>();
  readonly deleteRequested = output<string>();
  /** A double-click on something that carries text: put a caret in it. */
  readonly editRequested = output<string>();
  readonly textChanged = output<{ id: string; text: string }>();
  readonly editingEnded = output<void>();
  /**
   * What the menu is about to be opened for, emitted *before* it opens.
   *
   * Deliberately not `selectionChanged`: in Protect and the sign request
   * builder a selection is destructive, so routing a right-click through it
   * would delete the very thing the user meant to right-click.
   */
  readonly contextTarget = output<string | null>();
  readonly menuAction = output<{ action: string; itemId: string | null }>();

  private docsSvc = inject(DocumentsService);
  private surface = viewChild<ElementRef<HTMLDivElement>>('surface');
  private textEditor = viewChild<ElementRef<HTMLTextAreaElement>>('textEditor');
  private menuEl = viewChild<ElementRef<HTMLDivElement>>('overlayMenu');
  // Not `inject(ElementRef<HTMLElement>)`, which reads as though it types the
  // host and does not — that is an instantiation expression, and `inject`
  // resolves it back to `ElementRef<any>`. Same emitted call either way.
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);

  protected imageUrl = signal<string | null>(null);
  /**
   * The raster that actually **decoded**, with a non-zero natural size.
   *
   * Annotate, Edit, Forms, Protect and Sign draw the page as an `<img>` rather
   * than through pdf.js, so "the page drew" is a different event here — and a
   * broken or empty raster still fires `load`. Keyed on the URL for the same
   * reason as the viewer's `pageDrawn`: a new page or a new version withdraws
   * the claim without anything having to remember to clear it.
   */
  private drewUrl = signal<string | null>(null);
  protected readonly rasterDrawn = computed(
    () => !!this.drewUrl() && this.drewUrl() === this.imageUrl(),
  );
  /** Natural page aspect (height / width), so the box matches the raster exactly. */
  protected aspect = signal(842 / 595);
  protected drag = signal<Drag | null>(null);
  /** Vertices committed so far for polygon/polyline (click-to-add, Enter/dbl-click to finish). */
  protected pending = signal<NormPoint[]>([]);
  protected hoverPoint = signal<NormPoint | null>(null);
  protected menu = signal<MenuState | null>(null);
  /** The list resolved when the menu opened — rendered, and navigated. */
  protected menuActions = signal<OverlayMenuAction[]>([]);
  /** Which menu entry the keyboard is on — the highlight is drawn from this,
   *  not from `:focus-visible`, because a menu opened by a right-click never
   *  matches `:focus-visible` and its first item would look unfocused. */
  protected menuIndex = signal(0);
  /** Announced to screen readers: what got selected, where a nudge went. */
  protected liveMessage = signal('');

  private objectUrl: string | null = null;
  private menuOpenedBy: HTMLElement | null = null;
  /** What the live region last named, so a nudge is not talked over. */
  private announcedId: string | null = null;

  protected readonly boxHeight = computed(() =>
    Math.round(this.renderWidth() * this.aspect()),
  );

  protected readonly cursor = computed(() => {
    if (this.readonlyMode()) return 'default';
    switch (this.tool()) {
      case 'select':
        return 'default';
      case 'text':
        return 'text';
      case 'ink':
        return 'crosshair';
      default:
        return 'crosshair';
    }
  });

  /** Indexes of the entries the arrow keys are allowed to land on. */
  protected readonly enabledMenuIndexes = computed(() =>
    this.menuActions()
      .map((action, index) => (action.disabled ? -1 : index))
      .filter((index) => index >= 0),
  );

  /** The currently selected item, if it is on this page. */
  protected readonly selectedItem = computed<OverlayItem | undefined>(() => {
    const id = this.selectedId();
    if (!id) return undefined;
    return this.items().find((item) => item.id === id && item.page === this.page());
  });

  constructor() {
    // Move real focus with the highlight, so a screen reader reads each entry
    // as it is reached. Guarded on the menu being open so it does not steal
    // focus from the page.
    effect(() => {
      const state = this.menu();
      const index = this.menuIndex();
      if (!state) return;
      queueMicrotask(() => {
        const buttons = this.menuEl()?.nativeElement.querySelectorAll<HTMLButtonElement>('button');
        buttons?.[index]?.focus({ preventScroll: true });
      });
    });

    // A page change closes the menu with everything else it abandons.
    effect(() => {
      this.page();
      this.menu.set(null);
    });

    // Selection is a pointer gesture with no visible text, so it is invisible
    // to a screen reader unless something says it out loud.
    //
    // Keyed on the *id*, not the item: a nudge replaces the item object, and
    // announcing the selection again on every arrow press wiped out "Moved
    // right" before anything could read it.
    effect(() => {
      const item = this.selectedItem();
      const id = item?.id ?? null;
      if (id === this.announcedId) return;
      this.announcedId = id;
      if (item) this.announce(`${item.label || SHAPE_NAMES[item.shape] || 'Item'} selected`);
    });

    effect((onCleanup) => {
      const id = this.docId();
      const page = this.page();
      const version = this.version();
      const width = this.renderWidth();
      // 2x for a crisp raster on HiDPI, clamped to the server's cap so the
      // render stays inside the <1 s single-page budget (§3, §13).
      const sub = this.docsSvc
        .thumbnailBlob(id, page, Math.min(2000, Math.round(width * 2)), version)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (blob) => {
            this.revoke();
            this.objectUrl = URL.createObjectURL(blob);
            this.imageUrl.set(this.objectUrl);
          },
          error: () => this.imageUrl.set(null),
        });
      onCleanup(() => {
        sub.unsubscribe();
        this.revoke();
      });
    });
    // A page change abandons any half-drawn shape rather than carrying it over.
    effect(() => {
      this.page();
      this.pending.set([]);
      this.drag.set(null);
    });
    // A box you have just drawn should already have the caret in it — asking
    // the user to hunt for where to type is what made the tool feel broken.
    effect(() => {
      const editor = this.textEditor()?.nativeElement;
      if (!editor || document.activeElement === editor) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
  }

  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  protected onImageLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    if (img.naturalWidth > 0) {
      this.aspect.set(img.naturalHeight / img.naturalWidth);
      this.drewUrl.set(img.getAttribute('src'));
    }
  }

  // ------------------------------------------------------------------ //
  // Coordinate conversion — the only place pixels exist
  // ------------------------------------------------------------------ //
  private toNorm(event: PointerEvent | MouseEvent): NormPoint {
    const host = this.surface()?.nativeElement;
    if (!host) return [0, 0];
    const box = host.getBoundingClientRect();
    return [
      clamp01((event.clientX - box.left) / (box.width || 1)),
      clamp01((event.clientY - box.top) / (box.height || 1)),
    ];
  }

  protected px(value: number): number {
    return value * this.renderWidth();
  }

  protected pyv(value: number): number {
    return value * this.boxHeight();
  }

  /** Stroke widths are authored in PDF points; scale them the way the page scaled. */
  protected strokePx(item: OverlayItem): number {
    const pts = item.width ?? 1;
    return Math.max(1, (pts * this.renderWidth()) / 595);
  }

  protected pointsAttr(points: NormPoint[] | undefined): string {
    return (points ?? []).map((p) => `${this.px(p[0])},${this.pyv(p[1])}`).join(' ');
  }

  protected inkPath(strokes: NormPoint[][] | undefined): string {
    return (strokes ?? [])
      .map((stroke) =>
        stroke
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${this.px(p[0])} ${this.pyv(p[1])}`)
          .join(' '),
      )
      .join(' ');
  }

  // ------------------------------------------------------------------ //
  // Pointer gestures
  // ------------------------------------------------------------------ //
  protected onPointerDown(event: PointerEvent): void {
    if (this.readonlyMode()) return;
    // Only the primary button draws, selects and drags.
    //
    // `pointerdown` fires *before* `contextmenu`, and without this guard a
    // right-click ran the whole left-click path first: it cleared the
    // selection, started a latched `move` drag with `setPointerCapture` on
    // button 2 — and in Protect, where selecting an area removed it, it
    // deleted the thing the user was trying to open a menu on.
    if (event.button !== 0) return;
    // A click anywhere on the page dismisses an open menu.
    if (this.menu()) this.closeMenu();
    const point = this.toNorm(event);
    const tool = this.tool();

    if (tool === 'select') {
      this.selectionChanged.emit(null);
      return;
    }
    if (tool === 'text') return; // handled by the text layer

    if (tool === 'polygon' || tool === 'polyline') {
      // Click-to-add: a polygon is not a drag gesture.
      this.pending.update((pts) => [...pts, point]);
      return;
    }

    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();

    if (tool === 'point') {
      this.created.emit({
        shape: 'point',
        page: this.page(),
        rect: { x: point[0], y: point[1], w: 0.02, h: 0.02 },
      });
      return;
    }
    if (tool === 'ink') {
      this.drag.set({ kind: 'ink', start: point, current: point, stroke: [point] });
      return;
    }
    this.drag.set({ kind: 'draw', start: point, current: point });
  }

  protected onPointerMove(event: PointerEvent): void {
    const point = this.toNorm(event);
    if (this.pending().length) this.hoverPoint.set(point);
    const drag = this.drag();
    if (!drag) return;
    if (drag.kind === 'select-text') {
      // A text selection is measured in *word indices*, not coordinates, and
      // it is extended by `pointerenter` on the words themselves. This handler
      // sees the same moves bubbling up from those spans, and writing `point`
      // into `current` here would overwrite the end-of-selection index with a
      // y-fraction — collapsing every drag to the single word it started on.
      return;
    }
    if (drag.kind === 'ink') {
      this.drag.set({ ...drag, current: point, stroke: [...(drag.stroke ?? []), point] });
      return;
    }
    this.drag.set({ ...drag, current: point });
  }

  protected onPointerUp(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag) return;
    if (drag.kind === 'select-text') {
      // Released off the words (in the margin, say) — still commit what was
      // selected rather than leaving the drag latched.
      this.onTextPointerUp();
      return;
    }
    const point = this.toNorm(event);
    this.drag.set(null);

    if (drag.kind === 'ink') {
      const stroke = smoothStroke([...(drag.stroke ?? []), point]);
      if (stroke.length >= 2) {
        this.created.emit({ shape: 'ink', page: this.page(), ink: [stroke] });
      }
      return;
    }

    if (drag.kind === 'move' || drag.kind === 'resize') {
      const rect = this.dragRect(drag, point);
      // A click *is* a zero-distance drag. Reporting it as a geometry change
      // made every click on a shape a history entry, so the first ⌘Z after
      // selecting something undid nothing anyone could see.
      if (drag.itemId && rect && drag.originRect && !sameRect(rect, drag.originRect)) {
        this.geometryChanged.emit({ id: drag.itemId, rect, from: drag.originRect });
      }
      return;
    }

    const rect = normalizeRect(drag.start, point);
    // Reject a click (both tiny) *and* a degenerate drag along one axis: a
    // zero-height rect is not a shape anyone meant to draw, and the schema
    // rejects it server-side (`exclusiveMinimum: 0`) as a 400 the user cannot
    // act on.
    if (rect.w < 0.004 || rect.h < 0.004) return;

    const tool = this.tool();
    if (tool === 'line' || tool === 'arrow') {
      this.created.emit({
        shape: tool,
        page: this.page(),
        points: [drag.start, point],
      });
      return;
    }
    this.created.emit({
      shape: tool === 'ellipse' ? 'ellipse' : 'rect',
      page: this.page(),
      rect,
    });
  }

  /** Enter finishes a polygon/polyline; a double-click does the same. */
  protected finishPending(): void {
    const points = this.pending();
    this.pending.set([]);
    this.hoverPoint.set(null);
    const tool = this.tool();
    if (points.length < 2) return;
    if (tool === 'polygon' && points.length < 3) return;
    this.created.emit({
      shape: tool === 'polygon' ? 'polygon' : 'polyline',
      page: this.page(),
      points,
    });
  }

  // ------------------------------------------------------------------ //
  // Selection, move, resize
  // ------------------------------------------------------------------ //
  protected onItemPointerDown(event: PointerEvent, item: OverlayItem): void {
    if (this.readonlyMode() || this.tool() !== 'select' || item.locked) return;
    if (event.button !== 0) return; // see `onPointerDown`
    if (this.menu()) this.closeMenu();
    event.stopPropagation();
    this.selectionChanged.emit(item.id);
    if (!item.rect) return;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    const start = this.toNorm(event);
    this.drag.set({
      kind: 'move', start, current: start, itemId: item.id, originRect: item.rect,
    });
  }

  protected onHandlePointerDown(event: PointerEvent, item: OverlayItem, handle: Handle): void {
    if (this.readonlyMode() || this.readonlyHandles() || !item.rect) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    const start = this.toNorm(event);
    this.drag.set({
      kind: 'resize', start, current: start, itemId: item.id, handle, originRect: item.rect,
    });
  }

  private dragRect(drag: Drag, point: NormPoint): NormRect | undefined {
    const origin = drag.originRect;
    if (!origin) return undefined;
    const dx = point[0] - drag.start[0];
    const dy = point[1] - drag.start[1];
    if (drag.kind === 'move') {
      return {
        x: clamp01(Math.min(origin.x + dx, 1 - origin.w)),
        y: clamp01(Math.min(origin.y + dy, 1 - origin.h)),
        w: origin.w,
        h: origin.h,
      };
    }
    const left = origin.x;
    const top = origin.y;
    const right = origin.x + origin.w;
    const bottom = origin.y + origin.h;
    const corners: Record<Handle, [NormPoint, NormPoint]> = {
      nw: [[right, bottom], [left + dx, top + dy]],
      ne: [[left, bottom], [right + dx, top + dy]],
      sw: [[right, top], [left + dx, bottom + dy]],
      se: [[left, top], [right + dx, bottom + dy]],
    };
    const [anchor, moving] = corners[drag.handle ?? 'se'];
    const rect = normalizeRect(anchor, [clamp01(moving[0]), clamp01(moving[1])]);
    // Below this a shape is indistinguishable from a stray click and becomes
    // impossible to grab again.
    if (rect.w < 0.005 || rect.h < 0.005) return undefined;
    return rect;
  }

  /** The live preview of whatever is being dragged. */
  protected previewRect(): NormRect | null {
    const drag = this.drag();
    if (!drag) return null;
    if (drag.kind === 'draw') return normalizeRect(drag.start, drag.current);
    if (drag.kind === 'move' || drag.kind === 'resize') {
      return this.dragRect(drag, drag.current) ?? null;
    }
    return null;
  }

  protected previewInk(): NormPoint[][] | null {
    const drag = this.drag();
    return drag?.kind === 'ink' && drag.stroke ? [drag.stroke] : null;
  }

  protected previewLine(): NormPoint[] | null {
    const drag = this.drag();
    const tool = this.tool();
    if (drag?.kind !== 'draw') return null;
    if (tool !== 'line' && tool !== 'arrow') return null;
    return [drag.start, drag.current];
  }

  protected pendingPreview(): NormPoint[] | null {
    const pts = this.pending();
    if (!pts.length) return null;
    const hover = this.hoverPoint();
    return hover ? [...pts, hover] : pts;
  }

  // ------------------------------------------------------------------ //
  // Text layer → quads
  // ------------------------------------------------------------------ //
  protected onTextPointerDown(event: PointerEvent, word: OverlayWord): void {
    if (this.readonlyMode() || this.tool() !== 'text') return;
    if (event.button !== 0) return;
    event.preventDefault();
    // Deliberately NO `setPointerCapture` here, unlike every other gesture.
    // Capturing suppresses boundary events on every other element, so
    // `pointerenter` would never fire on the rest of the words and a drag
    // across a sentence would select only the word it started on. Extending a
    // selection *is* the boundary events; the release is caught on the layer
    // and, as a backstop, on the surface below it.
    this.drag.set({
      kind: 'select-text',
      start: [word.i, word.i],
      current: [word.i, word.i],
    });
  }

  protected onTextPointerEnter(word: OverlayWord): void {
    const drag = this.drag();
    if (drag?.kind !== 'select-text') return;
    this.drag.set({ ...drag, current: [drag.start[0], word.i] });
  }

  protected onTextPointerUp(): void {
    const drag = this.drag();
    if (drag?.kind !== 'select-text') return;
    this.drag.set(null);
    const [lo, hi] = [
      Math.min(drag.start[0], drag.current[1]),
      Math.max(drag.start[0], drag.current[1]),
    ];
    const selected = this.words().filter((w) => w.i >= lo && w.i <= hi);
    const quads = quadsFromWords(selected);
    if (quads.length) {
      this.created.emit({ shape: 'quads', page: this.page(), quads });
    }
  }

  protected isWordSelected(word: OverlayWord): boolean {
    const drag = this.drag();
    if (drag?.kind !== 'select-text') return false;
    const lo = Math.min(drag.start[0], drag.current[1]);
    const hi = Math.max(drag.start[0], drag.current[1]);
    return word.i >= lo && word.i <= hi;
  }

  // ------------------------------------------------------------------ //
  // Keyboard
  // ------------------------------------------------------------------ //
  protected onKeyDown(event: KeyboardEvent): void {
    // While the menu is open it owns the keyboard completely. Without this,
    // walking the menu with the arrow keys would also nudge the shape under
    // it, and reaching for an entry with Delete would destroy the item the
    // menu belongs to.
    if (this.menu()) return;

    const action = resolveShortcut(event);

    if (action === 'cancel') {
      // ESC always means "abandon what I am doing", at every level.
      if (this.drag() || this.pending().length) {
        this.drag.set(null);
        this.pending.set([]);
        this.hoverPoint.set(null);
      } else {
        this.selectionChanged.emit(null);
      }
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && this.pending().length) {
      this.finishPending();
      event.preventDefault();
      return;
    }
    if (action === 'context-menu') {
      if (this.openMenuForSelection()) event.preventDefault();
      return;
    }
    if (action === 'delete' && this.selectedId()) {
      this.deleteRequested.emit(this.selectedId()!);
      event.preventDefault();
      return;
    }
    if (action && NUDGE_VECTORS[action]) {
      // Only swallow the key when something actually moved: with nothing
      // selected the arrows must still scroll the pane, which is the correct
      // default and the only way to reach the bottom of a tall page.
      if (this.nudge(action, event.shiftKey)) event.preventDefault();
    }
  }

  /**
   * Move the selection by a fraction of the page.
   *
   * Emitted through `geometryChanged` rather than a channel of its own, so
   * every consumer that already re-derives quads, ink strokes and vertices from
   * a drag gets nudging with no new code at all.
   */
  private nudge(action: string, fast: boolean): boolean {
    if (this.readonlyMode() || this.readonlyHandles()) return false;
    if (this.drag() || this.pending().length) return false;
    const item = this.selectedItem();
    if (!item?.rect || item.locked) return false;

    const [ux, uy] = NUDGE_VECTORS[action];
    const step = NUDGE_STEP * (fast ? NUDGE_SHIFT_MULTIPLIER : 1);
    const rect = nudgeRect(item.rect, ux * step, uy * step);
    if (rect.x === item.rect.x && rect.y === item.rect.y) {
      this.announce('At the edge of the page');
      return true; // handled: do not also scroll the pane
    }
    this.geometryChanged.emit({ id: item.id, rect, from: item.rect });
    this.announce(`Moved ${NUDGE_NAMES[action]}`);
    return true;
  }

  // ------------------------------------------------------------------ //
  // Context menu
  // ------------------------------------------------------------------ //
  /**
   * Open the menu for whatever is under the pointer.
   *
   * The item is found by hit-testing normalized rects rather than by walking up
   * from `event.target`: an item the feature marked `locked` is rendered
   * `pointer-events: none`, so the event lands on the surface and ancestry
   * would report "empty page" — which would offer *Paste* over a redaction
   * match. Geometry does not lie about what is there.
   */
  protected onContextMenu(event: MouseEvent): void {
    if (this.readonlyMode()) return;
    const point = this.toNorm(event);
    const item = this.itemAt(point);
    // A locked item is not editable and offers nothing; leave the browser's
    // own menu alone rather than opening an empty one.
    if (item?.locked) return;

    const itemId = item?.id ?? null;
    this.contextTarget.emit(itemId);
    const actions = this.menuActionsFor()(itemId);
    if (!actions.length) return; // nothing to offer — the browser's menu stands

    event.preventDefault();
    this.menuOpenedBy = this.host.nativeElement.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    this.menuActions.set(actions);
    this.openMenuAt(this.px(point[0]), this.pyv(point[1]), itemId);
  }

  /** Shift+F10 / the ContextMenu key: anchor on the selection, not on 0,0. */
  private openMenuForSelection(): boolean {
    const item = this.selectedItem();
    const itemId = item?.id ?? null;
    this.contextTarget.emit(itemId);
    const actions = this.menuActionsFor()(itemId);
    if (!actions.length) return false;
    this.menuOpenedBy = document.activeElement as HTMLElement | null;
    this.menuActions.set(actions);
    const rect = item?.rect;
    this.openMenuAt(
      rect ? this.px(rect.x) : this.renderWidth() / 2,
      rect ? this.pyv(rect.y + rect.h) : this.boxHeight() / 2,
      itemId,
    );
    return true;
  }

  /** Place the menu inside the page box, so the scrolling pane cannot clip it. */
  private openMenuAt(x: number, y: number, itemId: string | null): void {
    const height = MENU_PADDING + this.menuActions().length * MENU_ITEM_HEIGHT;
    this.menu.set({
      x: Math.max(0, Math.min(x, this.renderWidth() - MENU_MIN_WIDTH)),
      y: Math.max(0, Math.min(y, this.boxHeight() - height)),
      itemId,
    });
    this.menuIndex.set(this.enabledMenuIndexes()[0] ?? 0);
  }

  private itemAt(point: NormPoint): OverlayItem | undefined {
    const onPage = this.items().filter((item) => item.page === this.page() && item.rect);
    // Reverse render order: the one drawn last is the one on top.
    for (let i = onPage.length - 1; i >= 0; i -= 1) {
      const rect = onPage[i].rect!;
      if (
        point[0] >= rect.x && point[0] <= rect.x + rect.w
        && point[1] >= rect.y && point[1] <= rect.y + rect.h
      ) {
        return onPage[i];
      }
    }
    return undefined;
  }

  /**
   * Give the page the keyboard.
   *
   * Selecting a mark from a rail list leaves focus on the button that was
   * clicked, so Delete and the arrow keys — which belong to the page — would go
   * nowhere. Clicking the page itself focuses this host already (a `tabindex=0`
   * ancestor takes focus when a non-focusable child is clicked); this is the
   * same thing for the other route in.
   */
  focusSurface(): void {
    // `preventScroll`, always. The host *is* the whole page box, taller than
    // the pane that holds it, so a plain `focus()` scrolls it into view — which
    // moves the page out from under the pointer. Closing a menu did exactly
    // that: the next click landed on empty backdrop and cleared the selection.
    this.host.nativeElement.focus?.({ preventScroll: true });
  }

  protected closeMenu(restoreFocus = false): void {
    if (!this.menu()) return;
    this.menu.set(null);
    this.menuActions.set([]);
    if (restoreFocus) {
      (this.menuOpenedBy ?? this.host.nativeElement).focus?.({ preventScroll: true });
    }
    this.menuOpenedBy = null;
  }

  protected chooseMenuAction(action: OverlayMenuAction): void {
    if (action.disabled) return;
    const itemId = this.menu()?.itemId ?? null;
    this.closeMenu(true);
    this.menuAction.emit({ action: action.id, itemId });
  }

  /**
   * The menu's own keyboard, per the ARIA menu pattern.
   *
   * Every key it handles is stopped here rather than allowed to bubble: the
   * overlay host below is listening for the same arrows, Delete and Escape.
   */
  protected onMenuKeyDown(event: KeyboardEvent): void {
    const enabled = this.enabledMenuIndexes();
    if (!enabled.length) return;
    const at = Math.max(0, enabled.indexOf(this.menuIndex()));

    switch (event.key) {
      case 'ArrowDown':
        this.menuIndex.set(enabled[(at + 1) % enabled.length]);
        break;
      case 'ArrowUp':
        this.menuIndex.set(enabled[(at - 1 + enabled.length) % enabled.length]);
        break;
      case 'Home':
        this.menuIndex.set(enabled[0]);
        break;
      case 'End':
        this.menuIndex.set(enabled[enabled.length - 1]);
        break;
      case 'Escape':
      case 'Tab':
        this.closeMenu(true);
        break;
      case 'Enter':
      case ' ': {
        const action = this.menuActions()[this.menuIndex()];
        if (action) this.chooseMenuAction(action);
        break;
      }
      default:
        return; // not ours: let it through
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** Say something once, for whoever is listening through a screen reader. */
  private announce(message: string): void {
    this.liveMessage.set(message);
  }

  // ------------------------------------------------------------------ //
  // Text drawn on the page
  // ------------------------------------------------------------------ //
  /** A point size in the file, as pixels at the current zoom. */
  protected fontPx(item: OverlayItem): number {
    const pt = item.fontSize ?? 12;
    return Math.max(4, (pt / this.pageWidthPt()) * this.renderWidth());
  }

  /** Double-click inside a text item starts editing it, the way a caret works
   *  everywhere else. Only with the select tool: while a draw tool is armed a
   *  double-click is two draws, not an edit. */
  protected onItemDoubleClick(event: MouseEvent, item: OverlayItem): void {
    if (this.readonlyMode() || item.locked) return;
    if (this.tool() !== 'select' || item.text === undefined) return;
    event.stopPropagation();
    event.preventDefault();
    this.editRequested.emit(item.id);
  }

  /**
   * Commit on blur, not on every keystroke.
   *
   * The textarea already shows what is being typed, at the size and colour the
   * file will use, so there is nothing to gain from pushing each character
   * through the model — and one commit per sitting is what makes one ⌘Z undo
   * a sentence rather than a letter.
   */
  protected onTextBlur(item: OverlayItem, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    if (value !== item.text) this.textChanged.emit({ id: item.id, text: value });
    this.editingEnded.emit();
  }

  /** Escape and ⌘/Ctrl+Enter both mean "done"; plain Enter is a new line,
   *  because a text box on a page is a paragraph, not a form field. */
  protected onTextKeyDown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      (event.target as HTMLTextAreaElement).blur();
      event.preventDefault();
    }
  }

  protected trackItem = (_: number, item: OverlayItem): string => item.id;
  protected trackWord = (_: number, word: OverlayWord): number => word.i;
}
