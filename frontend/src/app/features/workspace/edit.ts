import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { EditFacade } from '../../abstraction/edit.facade';
import {
  Job,
  PageImage,
  PageLink,
  ReplaceReport,
  StampPosition,
  TextBlock,
  TextStyle,
} from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ConfirmService } from '../../shared/confirm.service';
import {
  OverlayDraft,
  OverlayItem,
  OverlayTool,
} from '../../shared/page-overlay/overlay-model';
import { ZenModal } from '../../shared/modal.directive';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { ToastService } from '../../shared/toast.service';

/** Which sub-tool of the Edit tab is active. */
export type EditMode = 'text' | 'add-text' | 'whiteout' | 'image' | 'link';
export type EditTab = 'edit' | 'stamps' | 'info';

const GESTURE: Record<EditMode, OverlayTool> = {
  text: 'select',
  'add-text': 'rect',
  whiteout: 'rect',
  image: 'rect',
  link: 'rect',
};

/**
 * The span that carries the most text in a block.
 *
 * phase-04 asks for "font-size/family approximated from the **dominant** span".
 * Taking `spans[0]` gets the first fragment, which in a heading followed by a
 * run of body text is routinely the wrong size.
 */
function dominantSpan(block: TextBlock) {
  let best: TextBlock['lines'][number]['spans'][number] | undefined;
  let bestLength = -1;
  for (const line of block.lines) {
    for (const span of line.spans) {
      if (span.text.length > bestLength) {
        bestLength = span.text.length;
        best = span;
      }
    }
  }
  return best;
}

const POSITIONS: StampPosition[] = [
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

/**
 * Edit mode (phase-04) — the differentiator cluster.
 *
 * Reuses `PageOverlay` unchanged: text blocks, whiteout areas, images and links
 * all become `OverlayItem`s, and the gestures come back as `OverlayDraft`s.
 * That is the whole point of building the overlay generically in Phase 3.
 */
@Component({
  selector: 'app-edit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageOverlay, ZenModal],
  templateUrl: './edit.html',
})
export class Edit {
  readonly docId = input.required<string>();
  readonly pageCount = input(1);
  readonly currentSeq = input<number | null>(null);
  /** Flipped on by Phase 6; until then the OCR CTA is visible but inert. */
  readonly ocrAvailable = input(false);

  readonly saved = output<Job>();
  readonly conflict = output<void>();
  readonly ocrRequested = output<void>();

  protected edits = inject(EditFacade);
  private docsSvc = inject(DocumentsService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private destroyRef = inject(DestroyRef);

  protected tab = signal<EditTab>('edit');
  protected mode = signal<EditMode>('text');
  protected page = signal(0);
  protected zoom = signal(750);
  protected busy = signal(false);

  // text editing
  protected editingBlock = signal<TextBlock | null>(null);
  /** Set while a freshly drawn "add text" box is waiting for its content. */
  protected addTextRect = signal<OverlayDraft['rect'] | null>(null);
  protected draftText = signal('');
  protected style = signal<TextStyle>({ font_family: 'helvetica', size: 11, color: '#211C15' });

  // find & replace
  protected findText = signal('');
  protected replaceText = signal('');
  protected matchCase = signal(false);

  // links
  protected linkDialog = signal(false);
  protected linkRect = signal<OverlayDraft['rect'] | null>(null);
  protected linkUri = signal('https://');

  // images
  protected selectedImage = signal<PageImage | null>(null);
  protected pendingImageRef = signal<string | null>(null);

  // stamps
  protected wmText = signal('DRAFT');
  protected wmOpacity = signal(0.25);
  protected wmRotation = signal(-45);
  protected wmSize = signal(48);
  protected wmColor = signal('#808080');
  protected wmTiled = signal(false);
  protected wmUnder = signal(true);
  protected wmSkipFirst = signal(false);
  protected wmImageRef = signal<string | null>(null);
  protected pnFormat = signal('{page}');
  protected pnPosition = signal<StampPosition>('bottom-center');
  protected pnStartAt = signal(1);
  protected pnSkipFirst = signal(false);
  // Six slots (§phase-04): a header *and* a footer in one operation.
  protected hfHeader = signal({ left: '', center: '', right: '' });
  protected hfFooterSlots = signal({ left: '', center: '', right: '' });
  protected hfSkipFirst = signal(false);
  protected batesPrefix = signal('');
  protected batesSuffix = signal('');
  protected batesStart = signal(1);
  protected batesDigits = signal(6);
  protected batesPosition = signal<StampPosition>('bottom-right');
  protected batesSkipFirst = signal(false);
  protected metaClear = signal(false);
  protected imageKeepAspect = signal(true);
  /** Overlay (letterhead) source — another document the caller owns. */
  protected overlayDocs = signal<{ id: string; title: string }[]>([]);
  protected overlayDocId = signal('');
  protected overlayMode = signal<'foreground' | 'background'>('background');

  // info
  protected metaTitle = signal('');
  protected metaAuthor = signal('');
  protected metaSubject = signal('');
  protected metaKeywords = signal('');
  protected bookmarks = signal<{ level: number; title: string; page: number }[]>([]);

  protected readonly positions = POSITIONS;
  protected readonly gesture = computed<OverlayTool>(() => GESTURE[this.mode()]);
  protected readonly scanned = computed(() => this.edits.isScanned(this.page()));

  /** Text blocks, images and links as overlay shapes — one generic renderer. */
  protected readonly overlayItems = computed<OverlayItem[]>(() => {
    const page = this.page();
    const mode = this.mode();
    const items: OverlayItem[] = [];

    if (mode === 'text') {
      for (const block of this.edits.blocksFor(page)) {
        const staged = this.edits.editFor(page, block.block_id);
        items.push({
          id: `b${block.block_id}`,
          page,
          shape: 'rect',
          rect: block.bbox,
          stroke: staged ? '#B23A26' : '#948A77',
          fill: staged ? '#c7d2fe' : null,
          opacity: staged ? 0.35 : 1,
          width: 1,
          label: staged ? 'edited' : undefined,
          data: { blockId: block.block_id },
        });
      }
    }
    if (mode === 'image') {
      for (const image of this.edits.imagesFor(page)) {
        items.push({
          id: `i${image.xref}`,
          page,
          shape: 'rect',
          rect: image.bbox,
          stroke: this.selectedImage()?.xref === image.xref ? '#B23A26' : '#3D6478',
          width: 2,
          label: `${image.width}×${image.height}`,
          data: { xref: image.xref },
        });
      }
    }
    if (mode === 'link') {
      for (const link of this.edits.linksFor(page)) {
        items.push({
          id: `l${link.index}`,
          page,
          shape: 'rect',
          rect: link.bbox,
          stroke: '#0891b2',
          width: 2,
          label: link.kind === 'uri' ? (link.uri ?? 'link') : `→ p${(link.page ?? 0) + 1}`,
          data: { index: link.index },
        });
      }
    }
    return items;
  });

  constructor() {
    // One effect, not two. Splitting "reset on version change" from "load the
    // page" made them fight: `reset()` replaced the very signal the loader
    // reads, dirtying it and refiring the fetch before the first response
    // landed — six requests per page open instead of three.
    let lastSeq: number | null | undefined;
    effect(() => {
      const seq = this.currentSeq();
      const page = this.page();
      if (lastSeq !== seq) {
        lastSeq = seq;
        this.edits.reset();
      }
      this.edits.load(this.docId(), page, seq);
    });
  }

  // ------------------------------------------------------------------ //
  // Text blocks
  // ------------------------------------------------------------------ //
  protected onSelect(id: string | null): void {
    if (!id) {
      this.selectedImage.set(null);
      return;
    }
    if (this.mode() === 'image') {
      const xref = Number(id.slice(1));
      this.selectedImage.set(
        this.edits.imagesFor(this.page()).find((i) => i.xref === xref) ?? null,
      );
      return;
    }
    if (this.mode() !== 'text') return;
    const blockId = Number(id.slice(1));
    const block = this.edits.blocksFor(this.page()).find((b) => b.block_id === blockId);
    if (!block) return;
    this.openEditor(block);
  }

  protected openEditor(block: TextBlock): void {
    const staged = this.edits.editFor(this.page(), block.block_id);
    this.editingBlock.set(block);
    this.draftText.set(staged?.new_text ?? block.text);
    const span = dominantSpan(block);
    if (span) {
      this.style.set({
        font_family: this.style().font_family,
        size: Math.round(span.size),
        color: span.color,
        bold: span.bold,
        italic: span.italic,
      });
    }
  }

  protected commitEditor(): void {
    const rect = this.addTextRect();
    if (rect) {
      const text = this.draftText().trim();
      this.addTextRect.set(null);
      if (!text) return;
      this.run('add_text',
               { boxes: [{ page: this.page(), rect, text, style: this.style() }] },
               'Text added');
      return;
    }
    const block = this.editingBlock();
    if (!block) return;
    this.edits.stageEdit(block, this.page(), this.draftText(), this.style());
    this.editingBlock.set(null);
  }

  protected cancelEditor(): void {
    this.editingBlock.set(null);
    this.addTextRect.set(null);
  }

  /** Editor box position, in the same px space the overlay renders in. */
  protected editorBox(): { left: number; top: number; width: number; height: number } | null {
    const rect = this.addTextRect() ?? this.editingBlock()?.bbox;
    if (!rect) return null;
    const w = this.zoom();
    const h = w * this.aspect();
    return {
      left: rect.x * w,
      top: rect.y * h,
      width: Math.max(80, rect.w * w),
      height: Math.max(28, rect.h * h),
    };
  }

  private aspect(): number {
    return this.edits.aspectFor(this.page());
  }

  protected save(): void {
    const job$ = this.edits.commitEdits(this.docId(), this.currentSeq());
    if (!job$) {
      this.toast.info('No text changes to save');
      return;
    }
    this.track(job$, 'Text updated');
  }

  // ------------------------------------------------------------------ //
  // Overlay gestures
  // ------------------------------------------------------------------ //
  protected onCreated(draft: OverlayDraft): void {
    if (!draft.rect) return;
    const mode = this.mode();
    if (mode === 'whiteout') {
      this.run('whiteout', { rects: [{ page: draft.page, rect: draft.rect }] },
               'Whiteout applied');
      return;
    }
    if (mode === 'add-text') {
      // Same inline editor as a block edit, so adding text and changing text
      // feel like one tool rather than two.
      this.addTextRect.set(draft.rect);
      this.draftText.set('');
      return;
    }
    if (mode === 'image') {
      const ref = this.pendingImageRef();
      if (!ref) {
        this.toast.info('Choose an image first');
        return;
      }
      this.run('add_image', { page: draft.page, rect: draft.rect, image_ref: ref },
               'Image added');
      this.pendingImageRef.set(null);
      return;
    }
    if (mode === 'link') {
      this.linkRect.set(draft.rect);
      this.linkDialog.set(true);
    }
  }

  // ------------------------------------------------------------------ //
  // Images
  // ------------------------------------------------------------------ //
  protected onImageFile(event: Event, replace = false): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.docsSvc.uploadImage(file).subscribe({
      next: (asset) => {
        if (replace) {
          const target = this.selectedImage();
          if (!target) return;
          this.run('replace_image',
                   { page: this.page(), xref: target.xref, image_ref: asset.ref },
                   'Image replaced');
        } else {
          this.pendingImageRef.set(asset.ref);
          this.mode.set('image');
          this.toast.success('Drag a box to place the image');
        }
      },
      error: (err) => this.toast.error(err?.error?.error?.message ?? 'Upload failed'),
    });
    input.value = '';
  }

  protected async deleteSelectedImage(): Promise<void> {
    const target = this.selectedImage();
    if (!target) return;
    if (await this.confirm.ask('Delete this image?', 'Delete')) {
      this.run('delete_image', { page: this.page(), xref: target.xref }, 'Image deleted');
      this.selectedImage.set(null);
    }
  }

  // ------------------------------------------------------------------ //
  // Links
  // ------------------------------------------------------------------ //
  protected saveLink(): void {
    const rect = this.linkRect();
    if (!rect) return;
    this.run('add_link',
             { page: this.page(), rect, kind: 'uri', uri: this.linkUri() },
             'Link added');
    this.linkDialog.set(false);
    this.linkRect.set(null);
  }

  protected deleteLink(link: PageLink): void {
    this.run('delete_link', { page: this.page(), index: link.index }, 'Link removed');
  }

  // ------------------------------------------------------------------ //
  // Find & replace
  // ------------------------------------------------------------------ //
  /** Changing the query invalidates any held report — see `reportQuery`. */
  protected onQueryChanged(): void {
    if (this.edits.report()) this.edits.setReport(null);
  }

  protected preview(): void {
    const find = this.findText().trim();
    if (!find) return;
    // Drop the previous results first: leaving them on screen next to a new
    // query shows matches for a search the user has already moved on from.
    this.edits.setReport(null);
    this.edits.rememberQuery(find, this.matchCase());
    this.busy.set(true);
    this.edits.preview(this.docId(), this.currentSeq(), find, this.matchCase()).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          this.busy.set(false);
          const report = (job.result?.['report'] as ReplaceReport) ?? null;
          this.edits.setReport(report);
          if (!report?.count) this.toast.info('No matches');
        } else if (job.status === 'failed') {
          this.busy.set(false);
          this.toast.error(job.error_message || 'Search failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.toast.error('Search failed');
      },
    });
  }

  protected executeReplace(): void {
    const kept = this.edits.keptIds();
    if (!kept.length) {
      this.toast.info('Nothing selected to replace');
      return;
    }
    // The ids are positional, so they only mean anything against the search
    // that produced them. Applying them with a changed query silently replaces
    // the wrong occurrences.
    const held = this.edits.reportQuery();
    const find = this.findText().trim();
    if (!held || held.find !== find || held.matchCase !== this.matchCase()) {
      this.edits.setReport(null);
      this.toast.info('The search changed — preview the matches again.');
      return;
    }
    this.busy.set(true);
    this.edits
      .execute(this.docId(), this.currentSeq(), find, this.replaceText(),
               this.matchCase())
      .subscribe({
        // Report what the *server* did, not what we asked for.
        next: (job) => this.onJob(
          job,
          `Replaced ${(job.result?.['report'] as { replaced?: number } | undefined)
            ?.replaced ?? kept.length} match(es)`,
        ),
        error: () => this.fail(),
      });
  }

  protected isKept(id: string): boolean {
    return !this.edits.excluded().has(id);
  }

  // ------------------------------------------------------------------ //
  // Stamps
  // ------------------------------------------------------------------ //
  protected applyWatermark(): void {
    const ref = this.wmImageRef();
    const params: Record<string, unknown> = {
      opacity: this.wmOpacity(), tiled: this.wmTiled(), under: this.wmUnder(),
      scale: 1, range: this.wmSkipFirst() ? { skip_first: true } : {},
    };
    if (ref) {
      params['image_ref'] = ref;
    } else {
      params['text'] = this.wmText();
      params['rotation'] = this.wmRotation();
      params['size'] = this.wmSize();
      params['color'] = this.wmColor();
    }
    this.run('watermark', params, 'Watermark applied');
  }

  protected onWatermarkImage(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.docsSvc.uploadImage(file).subscribe({
      next: (asset) => {
        this.wmImageRef.set(asset.ref);
        this.toast.success('Image ready — apply the watermark');
      },
      error: () => this.toast.error('Upload failed'),
    });
    input.value = '';
  }

  protected applyPageNumbers(): void {
    this.run('page_numbers', {
      position: this.pnPosition(), format: this.pnFormat(), start_at: this.pnStartAt(),
      range: this.pnSkipFirst() ? { skip_first: true } : {},
    }, 'Page numbers added');
  }

  protected applyHeaderFooter(): void {
    const segments: Record<string, string> = {};
    for (const [slot, value] of Object.entries(this.hfHeader())) {
      if (value) segments[`top-${slot}`] = value;
    }
    for (const [slot, value] of Object.entries(this.hfFooterSlots())) {
      if (value) segments[`bottom-${slot}`] = value;
    }
    if (!Object.keys(segments).length) {
      this.toast.info('Fill at least one slot');
      return;
    }
    this.run('header_footer', {
      segments,
      range: this.hfSkipFirst() ? { skip_first: true } : {},
    }, 'Header/footer applied');
  }

  protected setHeaderSlot(slot: 'left' | 'center' | 'right', value: string): void {
    this.hfHeader.update((v) => ({ ...v, [slot]: value }));
  }

  protected setFooterSlot(slot: 'left' | 'center' | 'right', value: string): void {
    this.hfFooterSlots.update((v) => ({ ...v, [slot]: value }));
  }

  protected applyBates(): void {
    this.run('bates', {
      prefix: this.batesPrefix(), suffix: this.batesSuffix(),
      start: this.batesStart(), digits: this.batesDigits(),
      position: this.batesPosition(),
      range: this.batesSkipFirst() ? { skip_first: true } : {},
    }, 'Bates numbering applied');
  }

  /** Stamp a page of another document over (or under) this one — letterheads. */
  protected loadOverlaySources(): void {
    this.docsSvc.list({}).subscribe({
      next: (page) => this.overlayDocs.set(
        page.results
          .filter((d) => d.id !== this.docId())
          .map((d) => ({ id: d.id, title: d.title })),
      ),
      error: () => this.overlayDocs.set([]),
    });
  }

  protected applyOverlay(): void {
    const id = this.overlayDocId();
    if (!id) {
      this.toast.info('Choose a document to overlay');
      return;
    }
    this.run('overlay_pdf', { overlay_document_id: id, mode: this.overlayMode() },
             'Overlay applied');
  }

  // ------------------------------------------------------------------ //
  // Info
  // ------------------------------------------------------------------ //
  protected applyMetadata(): void {
    if (this.metaClear()) {
      this.run('set_metadata', { clear: true }, 'Metadata cleared');
      return;
    }
    this.run('set_metadata', {
      title: this.metaTitle(), author: this.metaAuthor(),
      subject: this.metaSubject(), keywords: this.metaKeywords(),
    }, 'Metadata updated');
  }

  protected bookmarkToCurrentPage(index: number): void {
    this.updateBookmark(index, { page: this.page() + 1 });
  }

  protected addBookmark(): void {
    this.bookmarks.update((list) => [
      ...list, { level: 1, title: 'New bookmark', page: this.page() + 1 },
    ]);
  }

  protected removeBookmark(index: number): void {
    this.bookmarks.update((list) => list.filter((_, i) => i !== index));
  }

  protected updateBookmark(index: number, patch: Partial<{ level: number; title: string; page: number }>): void {
    this.bookmarks.update((list) =>
      list.map((b, i) => (i === index ? { ...b, ...patch } : b)),
    );
  }

  protected applyBookmarks(): void {
    this.run('set_bookmarks', {
      toc: this.bookmarks().map((b) => [b.level, b.title, b.page]),
    }, 'Bookmarks updated');
  }

  // ------------------------------------------------------------------ //
  // Shared job plumbing
  // ------------------------------------------------------------------ //
  private run(type: string, params: unknown, label: string): void {
    this.busy.set(true);
    this.edits.run(this.docId(), this.currentSeq(), type, params).subscribe({
      next: (job) => this.onJob(job, label),
      error: () => this.fail(),
    });
  }

  private track(job$: ReturnType<EditFacade['run']>, label: string): void {
    job$ = job$.pipe(takeUntilDestroyed(this.destroyRef));
    this.busy.set(true);
    job$.subscribe({
      next: (job) => this.onJob(job, label),
      error: () => this.fail(),
    });
  }

  private onJob(job: Job, label: string): void {
    if (job.status === 'succeeded') {
      this.busy.set(false);
      this.toast.success(label);
      this.edits.reset();
      this.saved.emit(job);
    } else if (job.status === 'failed') {
      this.busy.set(false);
      if (job.error_code === 'version_conflict') {
        this.toast.info('Document changed — refreshed');
        this.conflict.emit();
      } else if (job.error_code === 'text_overflow') {
        // The engine tells us the size that *would* fit; offering the number is
        // the whole point of the error contract.
        const fits = (job.error_details?.['fits_at_size'] as number) ?? null;
        this.toast.error(
          fits
            ? `That text does not fit. It would fit at about ${fits}pt.`
            : 'That text does not fit the box. Try a smaller size or a bigger box.',
        );
      } else {
        this.toast.error(job.error_message || 'That did not work');
      }
    }
  }

  private fail(): void {
    this.busy.set(false);
    this.toast.error('That did not work');
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount() - 1, p + 1));
  }
}
