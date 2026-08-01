import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { DocumentsService } from '../../core/services/documents.service';
import {
  NormPoint,
  NormRect,
  OverlayDraft,
  OverlayGeometryChange,
  OverlayItem,
  OverlayTool,
  OverlayWord,
  clamp01,
  normalizeRect,
  quadsFromWords,
  smoothStroke,
} from './overlay-model';

type Handle = 'nw' | 'ne' | 'sw' | 'se';

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
    tabindex: '0',
    class: 'block outline-none',
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
  /** Stroke/fill applied to the in-progress shape, so drawing previews truthfully. */
  readonly drawStroke = input('#e11d48');
  readonly drawFill = input<string | null>(null);
  readonly drawWidth = input(2);

  readonly created = output<OverlayDraft>();
  readonly geometryChanged = output<OverlayGeometryChange>();
  readonly selectionChanged = output<string | null>();
  readonly deleteRequested = output<string>();
  readonly pageMetrics = output<{ width: number; height: number }>();

  private docsSvc = inject(DocumentsService);
  private surface = viewChild<ElementRef<HTMLDivElement>>('surface');

  protected imageUrl = signal<string | null>(null);
  /** Natural page aspect (height / width), so the box matches the raster exactly. */
  protected aspect = signal(842 / 595);
  protected drag = signal<Drag | null>(null);
  /** Vertices committed so far for polygon/polyline (click-to-add, Enter/dbl-click to finish). */
  protected pending = signal<NormPoint[]>([]);
  protected hoverPoint = signal<NormPoint | null>(null);

  private objectUrl: string | null = null;

  protected readonly boxHeight = computed(() =>
    Math.round(this.renderWidth() * this.aspect()),
  );

  protected readonly isDrawing = computed(
    () => !this.readonlyMode() && this.tool() !== 'select',
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

  constructor() {
    effect((onCleanup) => {
      const id = this.docId();
      const page = this.page();
      const version = this.version();
      const width = this.renderWidth();
      // 2x for a crisp raster on HiDPI, clamped to the server's cap so the
      // render stays inside the <1 s single-page budget (§3, §13).
      const sub = this.docsSvc
        .thumbnailBlob(id, page, Math.min(2000, Math.round(width * 2)), version)
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
      this.pageMetrics.emit({ width: img.naturalWidth, height: img.naturalHeight });
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
    if (drag.kind === 'ink') {
      this.drag.set({ ...drag, current: point, stroke: [...(drag.stroke ?? []), point] });
      return;
    }
    this.drag.set({ ...drag, current: point });
  }

  protected onPointerUp(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag) return;
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
      if (drag.itemId && rect) {
        this.geometryChanged.emit({ id: drag.itemId, rect });
      }
      return;
    }

    const rect = normalizeRect(drag.start, point);
    // A click, not a drag: too small to be a deliberate shape.
    if (rect.w < 0.004 && rect.h < 0.004) return;

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
    if (this.readonlyMode() || !item.rect) return;
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
    if (!drag || drag.kind !== 'draw') return null;
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
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
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
    if (event.key === 'Escape') {
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
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId()) {
      this.deleteRequested.emit(this.selectedId()!);
      event.preventDefault();
    }
  }

  protected trackItem = (_: number, item: OverlayItem): string => item.id;
  protected trackWord = (_: number, word: OverlayWord): number => word.i;
}
