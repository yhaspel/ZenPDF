import { PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { apiError } from '../../core/api-error';
import { Annotation, AnnotationType, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ConfirmService } from '../../shared/confirm.service';
import { EditorClipboard } from '../../shared/editor-clipboard.service';
import {
  NormRect,
  OverlayDraft,
  OverlayGeometryChange,
  OverlayItem,
  OverlayMenuAction,
  OverlayTool,
  boundsOf,
  boundsOfPoints,
  nudgeRect,
  transformPoint,
  transformRect,
} from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { ShortcutId, resolveShortcut, shortcutTitle } from '../../shared/shortcuts';
import { ToastService } from '../../shared/toast.service';
import { WsDrawerHead } from '../../shared/ws-drawer-head';
import { WsDrawer } from '../../shared/ws-drawer';
import { FitWidth } from '../../shared/fit-width';
import { clampPageWidth } from '../../shared/page-fit';

/** Every palette entry, including the two that are not annotations. */
export type AnnotateTool = AnnotationType | 'select' | 'crop';

const MARKUP: AnnotationType[] = ['highlight', 'underline', 'strikeout', 'squiggly'];

/** Which overlay gesture each palette tool needs. */
const GESTURE: Record<AnnotateTool, OverlayTool> = {
  select: 'select',
  highlight: 'text',
  underline: 'text',
  strikeout: 'text',
  squiggly: 'text',
  note: 'point',
  free_text: 'rect',
  square: 'rect',
  circle: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  polygon: 'polygon',
  polyline: 'polyline',
  ink: 'ink',
  stamp: 'rect',
  image_stamp: 'rect',
  crop: 'rect',
};

const STANDARD_STAMPS = [
  'Approved', 'AsIs', 'Confidential', 'Departmental', 'Draft', 'Experimental',
  'Expired', 'Final', 'ForComment', 'ForPublicRelease', 'NotApproved',
  'NotForPublicRelease', 'Sold', 'TopSecret',
];

const AUTOSAVE_MS = 30_000;

/**
 * One line of type, as a multiple of its point size.
 *
 * `.page-text` sets `line-height: 1.25` and a 1 px inset above and below; at
 * any zoom a text box that is 1.4 × its font size tall in points holds one
 * line without clipping, and the FreeText appearance the file gets needs
 * about the same.
 */
const TEXT_LINE = 1.4;

/**
 * How far a pasted or duplicated mark lands from its original.
 *
 * Enough to see that there are two of them. Pasting exactly on top produces
 * one visible mark and two unsaved changes, which reads as a bug.
 */
const PASTE_OFFSET = 0.02;

/** The two working colours the palette moves between (design contract §3). */
const HIGHLIGHT_COLOR = '#facc15';
const INK_COLOR = '#332D24';

/** Which colour a tool belongs to: translucent marker, or ink on the page. */
type ToolFamily = 'markup' | 'ink';

function familyOf(tool: AnnotateTool): ToolFamily {
  return MARKUP.includes(tool as AnnotationType) ? 'markup' : 'ink';
}

/** The widest Annotate ever draws a page — its desk width. */
const MAX_PAGE = 900;

/**
 * A mark without whose-it-is.
 *
 * The server stamps the real author when the batch is applied, and copying
 * somebody else's comment with their name still on it is not a copy — it is
 * the forgery `isOwn()` already refuses to let anyone commit in the sidebar.
 */
function withoutIdentity(a: Annotation): Annotation {
  const copy: Annotation = { ...a };
  delete copy.author;
  delete copy.created;
  delete copy.modified;
  return copy;
}

function uuid(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `zen-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Annotate mode (phase-03).
 *
 * Owns the palette, the page under the overlay, the comments sidebar and the
 * save model. The overlay itself is generic and knows none of this — mapping
 * annotations onto `OverlayItem` and drafts back into annotations happens here,
 * which is exactly the seam phases 4/5/7/8 will reuse with their own models.
 */
@Component({
  selector: 'app-annotate',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageOverlay, WsDrawer, WsDrawerHead, FitWidth],
  templateUrl: './annotate.html',
  // Below `md` a mode's host has to be a growing flex item, or the column sizes
  // to its content and the bottom bar floats above the fold — `styles.scss`
  // §17c says it once, with the measurement. Inert at ≥ `md` (§10).
  host: { class: 'ws-pane-host' },
})
export class Annotate {
  readonly docId = input.required<string>();
  readonly pageCount = input(1);
  readonly currentSeq = input<number | null>(null);
  /** Pages currently selected in the organize grid — the crop tool's range. */
  readonly selectedPages = input<number[]>([]);
  /** Palette tool to open with, so "Crop" in the organize toolbar lands ready. */
  readonly initialTool = input<AnnotateTool>('select');

  readonly saved = output<Job>();
  readonly cropped = output<void>();
  readonly conflict = output<void>();

  protected annotations = inject(AnnotationsFacade);
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private guests = inject(GuestFacade);
  private clipboard = inject(EditorClipboard);
  private isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private shell = inject(WorkspaceShellFacade);
  private destroyRef = inject(DestroyRef);

  protected page = signal(0);
  protected tool = signal<AnnotateTool>('select');
  /**
   * Page width in pixels — fitted to the pane, unless the person has said
   * otherwise.
   *
   * Not fixed at 900, and no longer seeded from the viewport either: a phone is
   * 390 px wide, a 900 px page does not fit in it, and the viewport does not
   * know about the rails or about the scrollbar the pane has. `zoomOut` stops
   * at 450 by design, so the floor cannot come from the buttons — it comes from
   * whatever the pane last measured.
   *
   * Annotate is the only pane with a zoom control, so it is the only one where
   * re-fitting could take something away: `zoomChosen` is what stops a turned
   * phone, an opened drawer or a resized window from undoing a deliberate zoom.
   * Seeded at the desk width because that is the honest answer before any
   * layout has happened, including on a server that will never have one.
   */
  protected zoom = signal(MAX_PAGE);
  /** The widest page the pane can currently hold — the floor `zoomOut` stops at. */
  private fit = signal(MAX_PAGE);
  private zoomChosen = false;

  protected onFit(available: number): void {
    this.fit.set(clampPageWidth(MAX_PAGE, available));
    if (!this.zoomChosen) this.zoom.set(this.fit());
  }

  /**
   * The working colour, remembered per family of tools.
   *
   * One shared swatch meant a text box inherited the highlighter's yellow —
   * words drawn in #facc15 on white paper, which is what "the text box does
   * not show anything" looked like from the outside. Highlighters are yellow;
   * ink is ink; each family keeps whatever the user last chose for it.
   */
  private familyColors = signal<Record<ToolFamily, string>>({
    markup: HIGHLIGHT_COLOR,
    ink: INK_COLOR,
  });
  protected strokeWidth = signal(2);
  protected fontSize = signal(12);
  /** Opacity, remembered per family for the same reason colour is. */
  private familyOpacity = signal<Record<ToolFamily, number>>({ markup: 0.7, ink: 1 });
  protected stampName = signal(STANDARD_STAMPS[0]);
  protected busy = signal(false);
  protected cropRect = signal<{ x: number; y: number; w: number; h: number } | null>(null);
  protected lastSavedAt = signal<Date | null>(null);
  protected editingId = signal<string | null>(null);
  protected editingText = signal('');
  /**
   * The text box being typed into *on the page*.
   *
   * Separate from `editingId`, which drives the comments sidebar: a sticky
   * note has no on-page text to edit, and a text box should not open a second
   * editor in the margin while the caret is already on the page.
   */
  protected pageEditingId = signal<string | null>(null);

  protected readonly stamps = STANDARD_STAMPS;
  protected readonly key = shortcutTitle;

  protected readonly family = computed<ToolFamily>(() => familyOf(this.tool()));
  protected readonly color = computed(() => this.familyColors()[this.family()]);
  protected readonly opacity = computed(() => this.familyOpacity()[this.family()]);
  protected readonly gesture = computed<OverlayTool>(() => GESTURE[this.tool()]);
  protected readonly dirty = this.annotations.dirty;
  protected readonly words = computed(() => this.annotations.wordsFor(this.page()));
  /** The current page's width in points — how a point size becomes pixels. */
  protected readonly pageWidthPt = computed(() => this.annotations.pageWidthFor(this.page()));

  /** Annotations → overlay shapes. The overlay renders geometry, nothing else. */
  protected readonly overlayItems = computed<OverlayItem[]>(() =>
    this.annotations.all().map((a) => this.toOverlay(a)),
  );

  /** Whether there is a mark on the clipboard to paste. */
  protected readonly canPaste = computed(() => this.clipboard.has('annotation'));

  /**
   * The right-click menu for whatever is under the pointer.
   *
   * An empty list is the signal to the overlay that it should leave the
   * browser's own menu alone, which is what happens on empty page with nothing
   * copied.
   */
  /**
   * Called by the overlay, synchronously, with the item under the pointer.
   *
   * An arrow property rather than a method so the template can pass it by
   * reference; it reads signals directly, which is safe because it is only ever
   * called during an event.
   */
  protected menuActionsFor = (id: string | null): OverlayMenuAction[] => {
    if (!id) {
      return this.canPaste()
        ? [{ id: 'paste', label: 'Paste here', shortcut: this.key('paste') }]
        : [];
    }
    const item = this.annotations.all().find((a) => a.id === id);
    if (!item) return [];
    const actions: OverlayMenuAction[] = [
      { id: 'copy', label: 'Copy', shortcut: this.key('copy') },
      { id: 'cut', label: 'Cut', shortcut: this.key('cut') },
      { id: 'duplicate', label: 'Duplicate', shortcut: this.key('duplicate') },
    ];
    // Only a text box has words *on the page* to put a caret into; offering
    // "Edit text" on a highlight would be a menu entry that does nothing.
    if (item.type === 'free_text') {
      actions.push({ id: 'edit-text', label: 'Edit text…' });
    }
    actions.push({ id: 'edit-comment', label: 'Edit comment…' });
    if (this.canPaste()) {
      actions.push({ id: 'paste', label: 'Paste here', shortcut: this.key('paste') });
    }
    // No shortcut hint: it would read "Delete   Delete".
    actions.push({ id: 'delete', label: 'Delete', danger: true });
    return actions;
  };

  protected readonly comments = computed(() => {
    const grouped = this.annotations.byPage();
    return [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, items]) => ({ page, items }));
  });

  constructor() {
    // What the phone's bottom bar draws on this mode's behalf (design contract
    // §3 Phone workspace). Published rather than duplicated: below `md` the
    // page bar's own pair is `.ws-hoisted`, so exactly one of each is on screen.
    effect(() => this.shell.setPaneActions({
      undo: { label: 'Undo', disabled: !this.annotations.canUndo(), run: () => this.undo() },
      redo: { label: 'Redo', disabled: !this.annotations.canRedo(), run: () => this.redo() },
      primary: { label: 'Save', disabled: this.busy() || !this.dirty(), run: () => this.save() },
    }));
    this.destroyRef.onDestroy(() => this.shell.reset());

    effect(() => this.tool.set(this.initialTool()));

    // The text layer is only fetched for the page being marked up, and only
    // when a markup tool is active — a 300-page document must not pull 300
    // word lists to draw one rectangle.
    effect(() => {
      // Markup tools need the words themselves; the text-box tool needs only
      // the page's own width in points, which arrives on the same payload and
      // is what turns a point size into the right number of pixels.
      if (this.gesture() !== 'text' && this.tool() !== 'free_text') return;
      this.annotations.loadWords(this.docId(), this.page(), this.currentSeq());
    });

    effect((onCleanup) => {
      if (!this.isBrowser) return;
      const timer = setInterval(() => {
        if (this.annotations.dirty() && !this.busy()) this.save(true);
      }, AUTOSAVE_MS);
      onCleanup(() => clearInterval(timer));
    });

    // The editing keyboard (phase-12). One resolver, shared with every other
    // mode and with the shortcuts sheet, so a key cannot be bound here and
    // documented differently there.
    //
    // The listener is on `window` but its *lifetime* is the component's, which
    // is what keeps it clear of pdf.js: the viewer binds `window` keydown too
    // and claims ⌘S, +, - and PageUp/PageDown — and it is mounted only in View
    // mode and the Forms fill tab, where this component does not exist.
    effect((onCleanup) => {
      if (!this.isBrowser) return;
      const handler = (event: KeyboardEvent) => this.onShortcut(event);
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
    });

    // Unsaved-changes guard. Autosave makes the window small, but "small" is not
    // "none" — closing the tab 5 s after a change must still warn.
    effect((onCleanup) => {
      if (!this.isBrowser) return;
      const handler = (event: BeforeUnloadEvent) => {
        if (!this.annotations.dirty()) return;
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', handler);
      onCleanup(() => window.removeEventListener('beforeunload', handler));
    });
  }

  /**
   * Switching tool re-suggests colour and opacity, it does not lock them in.
   *
   * Translucency is what makes a highlight readable and what makes an arrow
   * look like a mistake; the same is true of yellow ink. Both settings are
   * therefore held per family and switch with the tool — and whatever the user
   * chose for a family is still there when they come back to it.
   */
  protected setTool(next: AnnotateTool): void {
    this.tool.set(next);
  }

  /** Colour changes apply to the family in hand, not to every tool at once. */
  protected setColor(value: string): void {
    const family = this.family();
    this.familyColors.update((colors) => ({ ...colors, [family]: value }));
  }

  protected setOpacity(value: number): void {
    const family = this.family();
    this.familyOpacity.update((values) => ({ ...values, [family]: value }));
  }

  // ------------------------------------------------------------------ //
  // Mapping
  // ------------------------------------------------------------------ //
  private toOverlay(a: Annotation): OverlayItem {
    const base: OverlayItem = {
      id: a.id,
      page: a.page,
      shape: 'rect',
      rect: a.rect,
      stroke: a.color ?? '#332D24',
      fill: a.fill ?? null,
      opacity: a.opacity ?? 1,
      width: a.width || 2,
      data: { type: a.type },
    };
    if (MARKUP.includes(a.type)) {
      return {
        ...base,
        shape: 'quads',
        quads: a.quads ?? [],
        rect: boundsOf(a.quads ?? []),
        fill: a.color ?? '#facc15',
      };
    }
    switch (a.type) {
      // Point-based shapes carry a *derived* bounding rect. Without one the
      // overlay has nothing to outline or drag, so ink, lines, arrows and
      // polygons had no selection handles and could not be moved at all —
      // half the "selection handles (move/resize)" requirement.
      case 'ink':
        return {
          ...base, shape: 'ink', ink: a.ink ?? [], fill: null,
          rect: boundsOfPoints((a.ink ?? []).flat()),
        };
      case 'line':
      case 'arrow':
        return {
          ...base, shape: a.type, points: a.vertices ?? [], fill: null,
          rect: boundsOfPoints(a.vertices ?? []),
        };
      case 'polygon':
      case 'polyline':
        return {
          ...base, shape: a.type, points: a.vertices ?? [],
          rect: boundsOfPoints(a.vertices ?? []),
        };
      case 'circle':
        return { ...base, shape: 'ellipse' };
      case 'note':
        return { ...base, fill: a.color ?? '#D8B25E', label: '❝' };
      case 'free_text':
        // No badge: the words go on the page, at their own size and colour,
        // where the file will put them.
        return {
          ...base,
          stroke: (a.width ?? 0) > 0 ? (a.color ?? '#332D24') : 'none',
          text: a.contents ?? '',
          fontSize: a.font_size ?? 12,
          textColor: a.color ?? '#332D24',
        };
      case 'stamp':
        return { ...base, label: a.stamp_name ?? 'Stamp' };
      case 'image_stamp':
        return { ...base, label: 'Image' };
      default:
        return base;
    }
  }

  // ------------------------------------------------------------------ //
  // Drawing
  // ------------------------------------------------------------------ //
  protected onCreated(draft: OverlayDraft): void {
    const tool = this.tool();
    if (tool === 'crop') {
      if (draft.rect) this.cropRect.set(draft.rect);
      return;
    }
    if (tool === 'select') return;

    const annotation: Annotation = {
      id: uuid(),
      page: draft.page,
      type: tool,
      color: this.color(),
      opacity: this.opacity(),
      width: this.strokeWidth(),
      contents: '',
    };

    if (MARKUP.includes(tool)) {
      if (!draft.quads?.length) return;
      annotation.quads = draft.quads;
    } else if (tool === 'ink') {
      if (!draft.ink?.length) return;
      annotation.ink = draft.ink;
    } else if (tool === 'line' || tool === 'arrow' || tool === 'polygon' || tool === 'polyline') {
      if (!draft.points?.length) return;
      annotation.vertices = draft.points;
    } else {
      if (!draft.rect) return;
      annotation.rect = draft.rect;
    }

    if (tool === 'note') {
      annotation.icon = 'Comment';
      annotation.contents = 'New note';
      // Keep the icon on the page. A click in the last 2.5% of the width gave
      // `x + w > 1`, which the JSON Schema cannot catch (it bounds x and w
      // separately) — so the whole batch failed in the engine instead, with a
      // message that named no annotation.
      const w = 0.025;
      const h = 0.02;
      annotation.rect = {
        x: Math.min(draft.rect?.x ?? 0, 1 - w),
        y: Math.min(draft.rect?.y ?? 0, 1 - h),
        w,
        h,
      };
    }
    if (tool === 'free_text') {
      // Empty, not the word "Text": the caret lands in the box immediately, so
      // placeholder prose would only have to be deleted. And no border — the
      // shared line-width slider was giving every text box a 2pt frame in
      // highlighter yellow, which is the "bold box with no text in it" people
      // reported.
      annotation.contents = '';
      annotation.font_size = this.fontSize();
      annotation.width = 0;
      annotation.rect = this.atLeastOneLine(annotation.rect!, draft.page);
    }
    if (tool === 'stamp') {
      annotation.stamp_name = this.stampName();
    }
    if (tool === 'image_stamp') {
      const stamp = this.annotations.stamp();
      if (!stamp) {
        this.toast.info('Upload a stamp image first');
        return;
      }
      annotation.image_ref = stamp.ref;
    }

    this.annotations.add(annotation);
    if (tool === 'free_text') {
      this.editOnPage(annotation.id);
    } else if (tool === 'note') {
      this.startEditing(annotation.id);
    }
  }

  /**
   * A text box is never shorter than one line of its type.
   *
   * Filling in a form means tracing its printed lines, and a line on a scan is
   * a few points tall — thinner than the type about to go into it. The box
   * clips to its rectangle (§3 "Text on the page"), on screen and in the file
   * alike, so a thin drag showed the top half of every word and read as the
   * text being cropped. Grown **upwards** to one line at the chosen size —
   * the traced line is where a person writes, and words sit on a line, not
   * under it — and clamped to the page; a drag that was already tall enough
   * is left exactly as drawn.
   */
  private atLeastOneLine(rect: NormRect, page: number): NormRect {
    const line = (this.fontSize() * TEXT_LINE) / this.annotations.pageHeightFor(page);
    if (rect.h >= line) return rect;
    const h = Math.min(line, 1);
    return { ...rect, y: Math.max(0, rect.y + rect.h - h), h };
  }

  /**
   * Put the caret in a text box on the page — after closing the one it may
   * already be in.
   *
   * The overlay ends the open editor itself when a gesture on the page starts,
   * so by the time a drawn box arrives here there is nothing left to close.
   * Undo, redo and the menu's "Edit text…" reach this without a gesture, and
   * for them the order matters: re-targeting first would tear the open editor
   * down uncommitted, and what happened next depended on which browser fired
   * `blur` for a removed element (`PageOverlay.finishEditing`).
   */
  private editOnPage(id: string | null): void {
    this.overlay()?.finishEditing();
    this.pageEditingId.set(id);
  }

  /**
   * The overlay moves a rectangle; the annotation's real geometry follows it.
   *
   * Quads, ink strokes and vertices are what the server rebuilds the annotation
   * from — writing only `rect` (the first cut of this) made a dragged highlight
   * snap back on the next render and leave a phantom unsaved change.
   */
  protected onGeometryChanged(change: OverlayGeometryChange): void {
    const item = this.annotations.all().find((a) => a.id === change.id);
    if (!item) return;
    const { from, rect } = change;

    if (MARKUP.includes(item.type)) {
      this.annotations.update(change.id, {
        quads: (item.quads ?? []).map((q) => transformRect(q, from, rect)),
      });
      return;
    }
    if (item.type === 'ink') {
      this.annotations.update(change.id, {
        ink: (item.ink ?? []).map((stroke) =>
          stroke.map((p) => transformPoint(p, from, rect)),
        ),
      });
      return;
    }
    if (item.vertices?.length) {
      this.annotations.update(change.id, {
        vertices: item.vertices.map((p) => transformPoint(p, from, rect)),
      });
      return;
    }
    this.annotations.update(change.id, { rect });
  }

  protected onSelectionChanged(id: string | null): void {
    this.annotations.select(id);
  }

  /** A double-click on a text box on the page puts the caret in it. */
  protected onEditRequested(id: string): void {
    this.annotations.select(id);
    this.editOnPage(id);
  }

  protected onPageTextChanged(change: { id: string; text: string }): void {
    this.annotations.update(change.id, { contents: change.text });
  }

  /**
   * The editor for `id` closed.
   *
   * Judged by the id the overlay names, never by `pageEditingId()`: the two
   * disagree exactly when it matters. Drawing the next box re-targets
   * `pageEditingId` before the previous editor is torn down, and reading the
   * signal here made the previous box's closing delete the *new* box for
   * being empty — every second text box vanished as it was drawn.
   */
  protected onPageEditingEnded(id: string): void {
    if (this.pageEditingId() === id) this.pageEditingId.set(null);
    // An empty box left behind is litter — nothing to see, nothing to save,
    // and impossible to select again once it has no border.
    const item = this.annotations.all().find((a) => a.id === id);
    if (item?.type === 'free_text' && !(item.contents ?? '').trim()) {
      this.annotations.remove(id);
    }
  }

  // ------------------------------------------------------------------ //
  // Keyboard, clipboard and the context menu
  // ------------------------------------------------------------------ //
  private onShortcut(event: KeyboardEvent): void {
    const hasTextSelection = !(window.getSelection()?.isCollapsed ?? true);
    const action = resolveShortcut(event, { hasTextSelection });
    if (!action) return;

    // The overlay owns these three itself, on the element that has focus —
    // handling them again here would delete twice and nudge twice.
    if (action === 'cancel' || action === 'delete' || action === 'context-menu') return;
    if (action.startsWith('nudge-')) return;

    const handled = this.runAction(action);
    if (handled) event.preventDefault();
  }

  private runAction(action: ShortcutId): boolean {
    switch (action) {
      case 'undo':
        this.undo();
        return true;
      case 'redo':
        this.redo();
        return true;
      case 'copy':
        return this.copySelected();
      case 'cut':
        return this.cutSelected();
      case 'paste':
        return this.pasteHere();
      case 'duplicate':
        return this.duplicateSelected();
      case 'save':
        this.save();
        return true;
      default:
        return false;
    }
  }

  /** The overlay reports what a right-click landed on before it opens. */
  protected onContextTarget(id: string | null): void {
    if (id) this.annotations.select(id);
  }

  protected onMenuAction(choice: { action: string; itemId: string | null }): void {
    const id = choice.itemId;
    switch (choice.action) {
      case 'copy':
        this.copySelected(id);
        break;
      case 'cut':
        this.cutSelected(id);
        break;
      case 'duplicate':
        this.duplicateSelected(id);
        break;
      case 'paste':
        this.pasteHere();
        break;
      case 'edit-text':
        if (id) this.onEditRequested(id);
        break;
      case 'edit-comment':
        if (id) this.startEditing(id);
        break;
      case 'delete':
        if (id) this.onDeleteRequested(id);
        break;
    }
  }

  /**
   * Put a mark on the editor's clipboard.
   *
   * Author and timestamps are deliberately dropped: the server stamps the real
   * author when the batch is applied, and copying somebody else's comment with
   * their name still on it is not a copy, it is a forgery — the same rule
   * `isOwn()` enforces in the sidebar.
   */
  protected copySelected(id: string | null = this.annotations.selectedId()): boolean {
    const item = id ? this.annotations.all().find((a) => a.id === id) : null;
    if (!item) return false;
    this.clipboard.copy('annotation', withoutIdentity(item));
    this.toast.info('Copied');
    return true;
  }

  protected cutSelected(id: string | null = this.annotations.selectedId()): boolean {
    if (!this.copySelected(id)) return false;
    this.annotations.remove(id ?? this.annotations.selectedId()!);
    return true;
  }

  /** Paste onto the page being looked at, not the page it was copied from. */
  protected pasteHere(): boolean {
    const held = this.clipboard.read<Annotation>('annotation');
    if (!held) return false;
    this.annotations.add(this.offsetCopy(held, this.page()));
    return true;
  }

  protected duplicateSelected(id: string | null = this.annotations.selectedId()): boolean {
    const item = id ? this.annotations.all().find((a) => a.id === id) : null;
    if (!item) return false;
    this.annotations.add(this.offsetCopy(item, item.page));
    return true;
  }

  /**
   * A copy of a mark, moved slightly, with a fresh identity.
   *
   * The offset is applied to the mark's *bounding box* and the real geometry
   * re-derived from how that box moved — the same affine step a drag uses — so
   * a multi-line highlight, an ink stroke and a polygon all move as one piece
   * rather than each part being nudged independently.
   */
  private offsetCopy(source: Annotation, page: number): Annotation {
    const copy: Annotation = { ...withoutIdentity(source), id: uuid(), page };
    const from = this.boundsOfAnnotation(source);
    if (!from) return copy;
    const to = nudgeRect(from, PASTE_OFFSET, PASTE_OFFSET);
    if (source.quads?.length) {
      copy.quads = source.quads.map((q) => transformRect(q, from, to));
    }
    if (source.ink?.length) {
      copy.ink = source.ink.map((stroke) => stroke.map((p) => transformPoint(p, from, to)));
    }
    if (source.vertices?.length) {
      copy.vertices = source.vertices.map((p) => transformPoint(p, from, to));
    }
    if (source.rect) copy.rect = to;
    return copy;
  }

  /** Where a mark is, whatever kind of geometry it happens to carry. */
  private boundsOfAnnotation(a: Annotation): NormRect | undefined {
    if (MARKUP.includes(a.type)) return boundsOf(a.quads ?? []);
    if (a.type === 'ink') return boundsOfPoints((a.ink ?? []).flat());
    if (a.vertices?.length) return boundsOfPoints(a.vertices);
    return a.rect;
  }

  protected undo(): void {
    this.editOnPage(null);
    this.annotations.undo();
  }

  protected redo(): void {
    this.editOnPage(null);
    this.annotations.redo();
  }

  protected onDeleteRequested(id: string): void {
    this.annotations.remove(id);
  }

  // ------------------------------------------------------------------ //
  // Comments sidebar
  // ------------------------------------------------------------------ //
  private overlay = viewChild(PageOverlay);

  protected jumpTo(annotation: Annotation): void {
    this.page.set(annotation.page);
    this.annotations.select(annotation.id);
    // The keyboard follows the selection onto the page: Delete and the arrow
    // keys belong to the overlay, and leaving focus on the sidebar button would
    // make both of them do nothing.
    this.overlay()?.focusSurface();
  }

  protected startEditing(id: string): void {
    const item = this.annotations.all().find((a) => a.id === id);
    this.editingId.set(id);
    this.editingText.set(item?.contents ?? '');
  }

  protected commitEditing(): void {
    const id = this.editingId();
    if (id) this.annotations.update(id, { contents: this.editingText() });
    this.editingId.set(null);
  }

  protected async clearPage(): Promise<void> {
    const here = this.annotations.byPage().get(this.page()) ?? [];
    if (!here.length) return;
    if (await this.confirm.ask(
      `Remove ${here.length} annotation(s) from page ${this.page() + 1}?`, 'Clear page',
    )) {
      for (const item of here) this.annotations.remove(item.id);
    }
  }

  protected async clearAll(): Promise<void> {
    if (!this.annotations.count()) return;
    if (await this.confirm.ask('Remove every annotation in this document?', 'Clear all')) {
      this.annotations.removeAll();
    }
  }

  /**
   * Who a mark is attributed to.
   *
   * The server stamps the real author when the batch is applied; until then a
   * draft has none, and defaulting to "Guest" told a signed-in user their own
   * comment belonged to somebody else.
   */
  protected authorOf(a: Annotation): string {
    if (a.author) return a.author;
    return this.guests.principal() === 'user' ? 'You' : 'Guest';
  }

  /** PDF date strings are `D:YYYYMMDDHHmmSS…`; show something a human reads. */
  protected timeOf(a: Annotation): string {
    const raw = a.modified || a.created || '';
    const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(raw);
    if (!m) return '';
    return `${m[3]}/${m[2]} ${m[4]}:${m[5]}`;
  }

  /**
   * phase-03: "edit **own** contents inline". An incoming PDF can carry other
   * people's comments, and silently rewriting those is not markup, it is
   * forgery — the server preserves their author on update, so the UI must not
   * offer the edit in the first place.
   */
  protected isOwn(a: Annotation): boolean {
    if (!a.author) return true; // a local draft is always ours
    return a.author === this.authorOf(a) || a.author === this.myName();
  }

  protected myName(): string {
    return this.guests.principal() === 'user' ? 'You' : 'Guest';
  }

  protected snippet(a: Annotation): string {
    if (a.contents) return a.contents;
    return a.type.replace('_', ' ');
  }

  // ------------------------------------------------------------------ //
  // Stamps
  // ------------------------------------------------------------------ //
  protected onStampFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.docsSvc.uploadImage(file).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (asset) => {
        this.annotations.useStamp(asset.ref, file);
        this.tool.set('image_stamp');
        this.toast.success('Stamp ready — drag a box to place it');
      },
      error: (err) => this.toast.error(apiError(err).message ?? 'Could not upload that image'),
    });
    input.value = '';
  }

  // ------------------------------------------------------------------ //
  // Save / flatten / crop
  // ------------------------------------------------------------------ //
  protected save(auto = false): void {
    const job$ = this.annotations.save(this.docId(), this.currentSeq());
    if (!job$) {
      if (!auto) this.toast.info('Nothing to save');
      return;
    }
    this.busy.set(true);
    job$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          this.busy.set(false);
          this.lastSavedAt.set(new Date());
          if (!auto) this.toast.success('Annotations saved');
          this.saved.emit(job);
        } else if (job.status === 'failed') {
          this.busy.set(false);
          if (job.error_code === 'version_conflict') {
            // v1 does not attempt a merge: keep the drafts and replay them onto
            // the reloaded version (phase-03 §"Save model UX").
            this.annotations.keepDraftsForReplay();
            this.toast.info('Document changed — your marks were kept. Save again to apply them.');
            this.conflict.emit();
          } else {
            this.toast.error(job.error_message || 'Could not save annotations');
          }
        }
      },
      error: () => {
        this.busy.set(false);
        this.toast.error('Could not save annotations');
      },
    });
  }

  protected async flatten(): Promise<void> {
    if (this.annotations.dirty()) {
      this.toast.info('Save your changes first');
      return;
    }
    const ok = await this.confirm.ask(
      'Flatten makes every annotation part of the page. They can no longer be edited or removed — you can still revert to an earlier version.',
      'Flatten',
    );
    if (!ok) return;
    this.busy.set(true);
    this.annotations.flatten(this.docId(), this.currentSeq())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          this.busy.set(false);
          this.toast.success('Annotations flattened');
          this.saved.emit(job);
        } else if (job.status === 'failed') {
          this.busy.set(false);
          this.toast.error(job.error_message || 'Could not flatten');
        }
      },
      error: () => {
        this.busy.set(false);
        this.toast.error('Could not flatten');
      },
    });
  }

  /**
   * Crop from a rectangle drawn on the page.
   *
   * This replaces the Phase-2 margin dialog (trim N% from each edge), which was
   * logged for revisit as soon as the overlay primitive existed — a crop you
   * cannot see is a crop you have to guess at.
   */
  protected applyCrop(): void {
    const rect = this.cropRect();
    if (!rect) {
      this.toast.info('Drag a rectangle to crop to');
      return;
    }
    const pages = this.selectedPages().length
      ? this.selectedPages()
      : Array.from({ length: this.pageCount() }, (_, i) => i);
    this.busy.set(true);
    this.jobs
      .dispatch(
        this.docsSvc.operation(this.docId(), {
          type: 'crop_pages',
          params: { pages, rect },
          base_version_seq: this.currentSeq(),
        }),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          if (job.status === 'succeeded') {
            this.busy.set(false);
            this.cropRect.set(null);
            this.tool.set('select');
            this.toast.success(`Cropped ${pages.length} page(s)`);
            this.cropped.emit();
          } else if (job.status === 'failed') {
            this.busy.set(false);
            if (job.error_code === 'version_conflict') {
              // Same recovery the margin dialog had before crop moved onto the
              // overlay: refresh rather than leave the user staring at an error.
              this.toast.info('Document changed — refreshed');
              this.conflict.emit();
            } else {
              this.toast.error(job.error_message || 'Could not crop');
            }
          }
        },
        error: () => {
          this.busy.set(false);
          this.toast.error('Could not crop');
        },
      });
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount() - 1, p + 1));
  }

  protected zoomIn(): void {
    this.zoomChosen = true;
    this.zoom.update((z) => Math.min(1600, z + 150));
  }

  protected zoomOut(): void {
    this.zoomChosen = true;
    this.zoom.update((z) => Math.max(Math.min(450, this.fit()), z - 150));
  }

  protected trackAnnotation = (_: number, a: Annotation): string => a.id;
}
