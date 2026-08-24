import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { EditFacade } from '../../abstraction/edit.facade';
import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
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
  OverlayMenuAction,
  OverlayTool,
} from '../../shared/page-overlay/overlay-model';
import { ZenModal } from '../../shared/modal.directive';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { ShortcutId, resolveShortcut, shortcutTitle } from '../../shared/shortcuts';
import { ToastService } from '../../shared/toast.service';
import { WsDrawerHead } from '../../shared/ws-drawer-head';
import { WsDrawer } from '../../shared/ws-drawer';

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
  imports: [FormsModule, PageOverlay, ZenModal, WsDrawer, WsDrawerHead],
  templateUrl: './edit.html',
  // A mode's host is a plain block, so the column above it sizes to its
  // content. That is invisible on a desk, where the content is always taller
  // than the screen, and it is not on a phone: the bottom bar has to be the
  // last row of a full-height column or it floats above the fold with paper
  // under it. `.ws-pane-host` gives the host the growth the column expects,
  // below `md` only — the desktop figure is an invariant (§10).
  host: { class: 'ws-pane-host' },
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
  private shell = inject(WorkspaceShellFacade);
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
  /**
   * Which link is selected.
   *
   * There was no such thing before phase-12: links could be deleted only from
   * the rail's list, and `deleteLink` asked for no confirmation at all — unlike
   * its image sibling — so the Delete key had nothing to act on and nothing to
   * ask. Both are fixed here.
   */
  protected selectedLink = signal<PageLink | null>(null);
  /** What the overlay's selection outline should be drawn around. */
  protected readonly selectedId = signal<string | null>(null);
  protected readonly key = shortcutTitle;

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
          fill: staged ? '#F6E4DD' : null,
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
          stroke: '#3D6478',
          width: 2,
          label: link.kind === 'uri' ? (link.uri ?? 'link') : `→ p${(link.page ?? 0) + 1}`,
          data: { index: link.index },
        });
      }
    }
    return items;
  });

  constructor() {
    // What the phone's bottom bar draws on this mode's behalf (design contract
    // §3 Phone workspace). Published rather than duplicated: below `md` the
    // page bar's own pair is `.ws-hoisted`, so exactly one of each is on screen.
    // The primary is offered only when the staged-text save is — everything
    // else Edit does is dispatched immediately and taken back by the *bar's*
    // Undo, which is a different button in a different place.
    effect(() => this.shell.setPaneActions({
      undo: {
        label: 'Undo the last text change',
        disabled: !this.edits.canUndo(),
        run: () => this.edits.undo(),
      },
      redo: { label: 'Redo', disabled: !this.edits.canRedo(), run: () => this.edits.redo() },
      ...(this.mode() === 'text' && this.edits.dirty()
        ? { primary: { label: 'Save', disabled: this.busy(), run: () => this.save() } }
        : {}),
    }));
    this.destroyRef.onDestroy(() => this.shell.reset());

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

    effect((onCleanup) => {
      if (typeof window === 'undefined') return;
      const handler = (event: KeyboardEvent) => this.onShortcut(event);
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
    });
  }

  // ------------------------------------------------------------------ //
  // Text blocks
  // ------------------------------------------------------------------ //
  protected onSelect(id: string | null): void {
    this.selectedId.set(id);
    if (!id) {
      this.selectedImage.set(null);
      this.selectedLink.set(null);
      return;
    }
    if (this.mode() === 'image') {
      this.selectedImage.set(this.imageFor(id) ?? null);
      return;
    }
    if (this.mode() === 'link') {
      this.selectedLink.set(this.linkFor(id) ?? null);
      return;
    }
    if (this.mode() !== 'text') return;
    const block = this.blockFor(id);
    if (!block) return;
    this.openEditor(block);
  }

  // ------------------------------------------------------------------ //
  // Keyboard and the context menu (phase-12)
  // ------------------------------------------------------------------ //
  private blockFor(id: string): TextBlock | undefined {
    return this.edits.blocksFor(this.page()).find((b) => b.block_id === Number(id.slice(1)));
  }

  private imageFor(id: string): PageImage | undefined {
    return this.edits.imagesFor(this.page()).find((i) => i.xref === Number(id.slice(1)));
  }

  private linkFor(id: string): PageLink | undefined {
    return this.edits.linksFor(this.page()).find((l) => l.index === Number(id.slice(1)));
  }

  protected onContextTarget(id: string | null): void {
    this.selectedId.set(id);
  }

  /**
   * What Edit offers on a right-click, per kind of thing.
   *
   * Every entry is an operation the mode already had — this is a shorter route
   * to them, not a new set of powers. Nothing is offered on empty page: Edit
   * has no clipboard of its own, because its items are read-models of the file
   * rather than local drafts that could be duplicated.
   */
  protected menuActionsFor = (id: string | null): OverlayMenuAction[] => {
    if (!id) return [];
    const mode = this.mode();
    if (mode === 'text') {
      const block = this.blockFor(id);
      if (!block) return [];
      const actions: OverlayMenuAction[] = [
        { id: 'edit-text', label: 'Edit text…' },
        { id: 'copy-text', label: 'Copy text', shortcut: this.key('copy') },
      ];
      if (this.edits.editFor(this.page(), block.block_id)) {
        actions.push({ id: 'discard-edit', label: 'Discard this edit', danger: true });
      }
      return actions;
    }
    if (mode === 'image' && this.imageFor(id)) {
      return [
        { id: 'replace-image', label: 'Replace image…' },
        { id: 'delete-image', label: 'Delete image', danger: true, shortcut: this.key('delete') },
      ];
    }
    if (mode === 'link' && this.linkFor(id)) {
      return [
        { id: 'copy-link', label: 'Copy link address', shortcut: this.key('copy') },
        { id: 'delete-link', label: 'Delete link', danger: true, shortcut: this.key('delete') },
      ];
    }
    return [];
  };

  protected onMenuAction(choice: { action: string; itemId: string | null }): void {
    const id = choice.itemId;
    if (!id) return;
    switch (choice.action) {
      case 'edit-text': {
        const block = this.blockFor(id);
        if (block) this.openEditor(block);
        break;
      }
      case 'copy-text': {
        const block = this.blockFor(id);
        if (block) void this.toClipboard(block.text);
        break;
      }
      case 'discard-edit': {
        const block = this.blockFor(id);
        if (block) {
          this.edits.discardEdit(this.page(), block.block_id);
          this.toast.info('Edit discarded');
        }
        break;
      }
      case 'replace-image':
        this.selectedImage.set(this.imageFor(id) ?? null);
        this.replaceInput()?.nativeElement.click();
        break;
      case 'delete-image':
        this.selectedImage.set(this.imageFor(id) ?? null);
        void this.deleteSelectedImage();
        break;
      case 'copy-link': {
        const link = this.linkFor(id);
        if (link?.uri) void this.toClipboard(link.uri);
        break;
      }
      case 'delete-link': {
        const link = this.linkFor(id);
        if (link) void this.deleteLink(link);
        break;
      }
    }
  }

  /**
   * The always-rendered file input the "Replace image…" menu entry opens.
   *
   * The panel's own replace input only exists while an image is selected, so
   * clicking it from the menu would race the render that creates it. A hidden
   * input that is always there makes the menu entry work on the first click,
   * every time.
   */
  private replaceInput = viewChild<ElementRef<HTMLInputElement>>('replaceImageInput');

  /**
   * Plain text *does* belong on the system clipboard — unlike a structured
   * annotation. Guarded because the async Clipboard API is absent on insecure
   * origins and in tests, where the toast is still the honest answer.
   */
  private async toClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
      this.toast.info('Copied');
    } catch {
      this.toast.info('Could not reach the clipboard');
    }
  }

  /** The overlay's Delete key. */
  protected onDeleteRequested(id: string): void {
    if (this.mode() === 'image') {
      this.selectedImage.set(this.imageFor(id) ?? null);
      void this.deleteSelectedImage();
      return;
    }
    if (this.mode() === 'link') {
      const link = this.linkFor(id);
      if (link) void this.deleteLink(link);
    }
  }

  private onShortcut(event: KeyboardEvent): void {
    const hasTextSelection = !(window.getSelection()?.isCollapsed ?? true);
    const action = resolveShortcut(event, { hasTextSelection });
    if (!action) return;
    if (action === 'cancel' || action === 'delete' || action === 'context-menu') return;
    if (action.startsWith('nudge-')) return;
    if (this.runAction(action)) event.preventDefault();
  }

  private runAction(action: ShortcutId): boolean {
    switch (action) {
      case 'undo':
        this.edits.undo();
        return true;
      case 'redo':
        this.edits.redo();
        return true;
      case 'save':
        this.save();
        return true;
      default:
        return false;
    }
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
    this.docsSvc.uploadImage(file).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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

  protected async deleteLink(link: PageLink): Promise<void> {
    const where = link.kind === 'uri' ? (link.uri ?? 'this link') : `page ${(link.page ?? 0) + 1}`;
    if (!(await this.confirm.ask(`Delete the link to ${where}?`, 'Delete'))) return;
    this.run('delete_link', { page: this.page(), index: link.index }, 'Link removed');
    this.selectedLink.set(null);
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
    this.edits.preview(this.docId(), this.currentSeq(), find, this.matchCase())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
      .pipe(takeUntilDestroyed(this.destroyRef))
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
    this.docsSvc.uploadImage(file).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
    this.docsSvc.list({}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
    this.edits.run(this.docId(), this.currentSeq(), type, params)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (job) => this.onJob(job, label),
      error: () => this.fail(),
    });
  }

  private track(job$: ReturnType<EditFacade['run']>, label: string): void {
    this.busy.set(true);
    job$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
