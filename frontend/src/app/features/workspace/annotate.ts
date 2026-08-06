import { PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { Annotation, AnnotationType, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ConfirmService } from '../../shared/confirm.service';
import {
  OverlayDraft,
  OverlayGeometryChange,
  OverlayItem,
  OverlayTool,
  boundsOf,
  boundsOfPoints,
  transformPoint,
  transformRect,
} from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { ToastService } from '../../shared/toast.service';

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
  imports: [FormsModule, PageOverlay],
  templateUrl: './annotate.html',
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
  private isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected page = signal(0);
  protected tool = signal<AnnotateTool>('select');
  protected zoom = signal(900);
  protected color = signal('#facc15');
  protected strokeWidth = signal(2);
  protected fontSize = signal(12);
  protected opacity = signal(0.7);
  protected stampName = signal(STANDARD_STAMPS[0]);
  protected stampRef = signal<string | null>(null);
  protected busy = signal(false);
  protected cropRect = signal<{ x: number; y: number; w: number; h: number } | null>(null);
  protected lastSavedAt = signal<Date | null>(null);
  protected editingId = signal<string | null>(null);
  protected editingText = signal('');

  protected readonly stamps = STANDARD_STAMPS;

  protected readonly gesture = computed<OverlayTool>(() => GESTURE[this.tool()]);
  protected readonly dirty = this.annotations.dirty;
  protected readonly words = computed(() => this.annotations.wordsFor(this.page()));

  /** Annotations → overlay shapes. The overlay renders geometry, nothing else. */
  protected readonly overlayItems = computed<OverlayItem[]>(() =>
    this.annotations.all().map((a) => this.toOverlay(a)),
  );

  protected readonly comments = computed(() => {
    const grouped = this.annotations.byPage();
    return [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, items]) => ({ page, items }));
  });

  constructor() {
    effect(() => this.tool.set(this.initialTool()));

    // The text layer is only fetched for the page being marked up, and only
    // when a markup tool is active — a 300-page document must not pull 300
    // word lists to draw one rectangle.
    effect(() => {
      if (this.gesture() !== 'text') return;
      this.annotations.loadWords(this.docId(), this.page(), this.currentSeq());
    });

    effect((onCleanup) => {
      if (!this.isBrowser) return;
      const timer = setInterval(() => {
        if (this.annotations.dirty() && !this.busy()) this.save(true);
      }, AUTOSAVE_MS);
      onCleanup(() => clearInterval(timer));
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
   * Switching tool re-suggests an opacity, it does not lock one in.
   *
   * Translucency is what makes a highlight readable and what makes an arrow
   * look like a mistake, so the two want different defaults — but forcing the
   * value at creation time (the first cut of this) made the slider do nothing
   * for eight of the fourteen tools.
   */
  protected setTool(next: AnnotateTool): void {
    const wasMarkup = MARKUP.includes(this.tool() as AnnotationType);
    const isMarkup = MARKUP.includes(next as AnnotationType);
    if (wasMarkup !== isMarkup) this.opacity.set(isMarkup ? 0.7 : 1);
    this.tool.set(next);
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
        return { ...base, label: (a.contents || 'Text').slice(0, 24) };
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
      annotation.contents = 'Text';
      annotation.font_size = this.fontSize();
    }
    if (tool === 'stamp') {
      annotation.stamp_name = this.stampName();
    }
    if (tool === 'image_stamp') {
      const ref = this.stampRef();
      if (!ref) {
        this.toast.info('Upload a stamp image first');
        return;
      }
      annotation.image_ref = ref;
    }

    this.annotations.add(annotation);
    if (tool === 'note' || tool === 'free_text') this.startEditing(annotation.id);
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

  protected async onDeleteRequested(id: string): Promise<void> {
    this.annotations.remove(id);
  }

  // ------------------------------------------------------------------ //
  // Comments sidebar
  // ------------------------------------------------------------------ //
  protected jumpTo(annotation: Annotation): void {
    this.page.set(annotation.page);
    this.annotations.select(annotation.id);
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
    this.docsSvc.uploadImage(file).subscribe({
      next: (asset) => {
        this.stampRef.set(asset.ref);
        this.tool.set('image_stamp');
        this.toast.success('Stamp ready — drag a box to place it');
      },
      error: (err) => this.toast.error(err?.error?.error?.message ?? 'Could not upload that image'),
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
    job$.subscribe({
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
    this.annotations.flatten(this.docId(), this.currentSeq()).subscribe({
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
    this.zoom.update((z) => Math.min(1600, z + 150));
  }

  protected zoomOut(): void {
    this.zoom.update((z) => Math.max(450, z - 150));
  }

  protected trackAnnotation = (_: number, a: Annotation): string => a.id;
}
