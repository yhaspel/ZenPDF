import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgxExtendedPdfViewerModule } from 'ngx-extended-pdf-viewer';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { CompareFacade } from '../../abstraction/compare.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { PagesFacade } from '../../abstraction/pages.facade';
import { SecurityFacade } from '../../abstraction/security.facade';
import { ViewerFacade } from '../../abstraction/viewer.facade';
import { Job, SearchHit } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { GuestTokenService } from '../../core/services/guest-token.service';
import { TokenService } from '../../core/services/token.service';
import { ConfirmService } from '../../shared/confirm.service';
import { PdfThumbnail } from '../../shared/pdf-thumbnail';
import { saveBlob } from '../../shared/save-blob';
import { ToastService } from '../../shared/toast.service';
import { Annotate, AnnotateTool } from './annotate';
import { Compare } from './compare';
import { Convert } from './convert';
import { Edit } from './edit';
import { Forms } from './forms';
import { Protect, ProtectTab } from './protect';

// `crop` left the dialog list in Phase 3: it is now drawn on the overlay
// (Human review queue, 2026-07-19 — "revisit crop to use it then").
type Dialog = null | 'split' | 'scale' | 'nup' | 'compress' | 'insert';

@Component({
  selector: 'app-workspace',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, RouterLink, NgxExtendedPdfViewerModule, CdkDropList, CdkDrag, PdfThumbnail,
    Annotate, Edit, Forms, Convert, Compare, Protect,
  ],
  templateUrl: './workspace.html',
})
export class Workspace {
  protected viewer = inject(ViewerFacade);
  protected pages = inject(PagesFacade);
  private jobs = inject(JobsFacade);
  private docsSvc = inject(DocumentsService);
  private tokens = inject(TokenService);
  protected guests = inject(GuestFacade);
  protected annotations = inject(AnnotationsFacade);
  private compares = inject(CompareFacade);
  protected security = inject(SecurityFacade);
  private guestTokens = inject(GuestTokenService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  protected leftTab = signal<'thumbs' | 'outline' | 'history'>('thumbs');
  protected mode = signal<
    'view' | 'organize' | 'annotate' | 'edit' | 'forms' | 'convert' | 'compare' | 'protect'
  >('view');
  protected annotateTool = signal<AnnotateTool>('select');
  protected protectTab = signal<ProtectTab>('protect');
  /** Set when Annotate was entered *from* the Organize toolbar's Crop button. */
  private cropReturnsToOrganize = false;
  /** Set when the Phase-4 scanned gate handed over to Convert. */
  private fromScannedGate = signal(false);
  protected page = signal(1);
  protected order = signal<number[]>([]);
  protected busy = signal(false);

  protected searchQuery = signal('');
  protected searchHits = signal<SearchHit[]>([]);
  protected searched = signal(false);

  protected renaming = signal(false);
  protected titleDraft = signal('');

  protected dialog = signal<Dialog>(null);
  protected splitMode = signal<'ranges' | 'every_n' | 'by_size_mb' | 'by_bookmarks'>('ranges');
  protected splitRanges = signal('1');
  protected splitEveryN = signal(1);
  protected scaleSize = signal<'a4' | 'letter' | 'legal'>('a4');
  protected nupPer = signal(2);
  protected compressPreset = signal<'light' | 'balanced' | 'strong'>('balanced');
  protected insertAt = signal(1);
  protected insertCount = signal(1);

  protected passwordPrompt = signal(false);
  /**
   * What PDF.js needs to render an encrypted document — read from the session
   * store rather than kept a second time here, so that unlocking anywhere (the
   * prompt, the Protect panel, or protecting the document in the first place)
   * is enough to make the viewer work.
   */
  protected readonly password = computed(() => {
    const doc = this.viewer.doc();
    if (!doc) return null;
    this.security.unlockedIds(); // the dependency; the map itself is not one
    return this.security.passwordFor(doc.id) || null;
  });

  readonly contentUrl = computed(() => {
    const d = this.viewer.doc();
    // Pinning the URL to the version seq is what makes `src` change after an
    // operation — without it the viewer keeps rendering the old bytes.
    return d?.current_version ? this.docsSvc.contentUrl(d.id, d.current_version.seq) : '';
  });
  /**
   * ngx-extended-pdf-viewer fetches the PDF **outside `HttpClient`**, so the
   * auth interceptor never runs for it (§21.2, trap 5). This is the one place
   * the credential has to be assembled by hand — miss it and a guest gets a
   * working workspace with a blank viewer.
   *
   * Depends on `guests.principal()` (a signal) rather than only reading
   * localStorage, so it recomputes when a token is minted or discarded.
   */
  readonly authHeaders = computed(() => {
    const headers: Record<string, string> = {};
    if (this.guests.principal() === 'user') {
      headers['Authorization'] = `Bearer ${this.tokens.access ?? ''}`;
      return headers;
    }
    const guestToken = this.guestTokens.token;
    if (guestToken) {
      headers['X-Guest-Token'] = guestToken;
    }
    return headers;
  });

  constructor() {
    // Angular reuses this component across /app/doc/:id navigations (split and
    // extract land on a new document), so track the param, not a snapshot.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id');
      if (id) this.viewer.load(id);
    });
    // `/annotate-pdf` hands off here with ?mode=annotate, so the public tool
    // page lands the guest directly in the markup tools (§21.6: the page must
    // *be* the tool, with no login prompt anywhere in the path).
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const mode = params.get('mode');
      if (mode === 'annotate' || mode === 'edit' || mode === 'forms'
          || mode === 'convert' || mode === 'compare' || mode === 'protect') {
        this.mode.set(mode);
      }
      // `/redact-pdf` and `/unlock-pdf` land on the same mode but on a
      // different tab — the page has to *be* the tool it advertised (§21.6).
      const tab = params.get('tab');
      if (mode === 'protect' && (tab === 'redact' || tab === 'sanitize')) {
        this.protectTab.set(tab);
      }
      // `/compare-pdf` uploads both documents and sends the second one here.
      // Without this the guest who just picked two files has to pick one of
      // them again from a dropdown — the page would stop being the tool.
      const other = params.get('other');
      if (mode === 'compare' && other) this.compares.setOther(other);
    });
    // reset organize order whenever the version changes
    effect(() => {
      const n = this.viewer.pageCount();
      this.viewer.currentSeq();
      this.order.set(Array.from({ length: n }, (_, i) => i));
      this.pages.clear();
    });
    // Annotations live in the file, so a new version is a new annotation set —
    // and every cached page word list is stale with it.
    //
    // Gated on annotate mode on purpose: reading annotations pulls the whole PDF
    // out of object storage and parses it in the API process, and it is keyed on
    // `viewer.doc()`, which is a *new object* after any refresh (a rename, for
    // instance). Ungated, every existing View/Organize user would pay that cost
    // on every open for a panel they never open.
    effect(() => {
      if (this.mode() !== 'annotate') return;
      const doc = this.viewer.doc();
      const seq = this.viewer.currentSeq();
      if (!doc) return;
      this.annotations.resetForVersion();
      this.annotations.load(doc.id, seq);
    });
    effect(() => {
      const doc = this.viewer.doc();
      // Not when the session already knows the password — including the case
      // where the user has just *chosen* it, which is no time to ask for it.
      if (doc?.is_encrypted && !this.security.isUnlocked(doc.id)) {
        this.passwordPrompt.set(true);
      }
    });
  }

  // --- selection / thumbnails ---
  onThumbClick(page: number, event: MouseEvent): void {
    if (this.mode() === 'organize') {
      if (event.shiftKey) {
        this.pages.selectRange(page);
      } else {
        this.pages.toggle(page, event.ctrlKey || event.metaKey);
      }
    } else {
      this.page.set(page + 1); // ngx viewer is 1-based
    }
  }

  drop(event: CdkDragDrop<number[]>): void {
    const next = [...this.order()];
    moveItemInArray(next, event.previousIndex, event.currentIndex);
    this.order.set(next);
    this.runOp('reorder_pages', { new_order: next }, 'Reordered pages');
  }

  // --- search ---
  doSearch(): void {
    const d = this.viewer.doc();
    const q = this.searchQuery().trim();
    if (!d || !q) return;
    this.docsSvc.search(d.id, q).subscribe({
      next: (res) => {
        this.searchHits.set(res.hits);
        this.searched.set(true);
        if (res.hits.length) this.page.set(res.hits[0].page + 1);
      },
    });
  }

  // --- rename / info / download ---
  startRename(): void {
    this.titleDraft.set(this.viewer.doc()?.title ?? '');
    this.renaming.set(true);
  }

  commitRename(): void {
    const t = this.titleDraft().trim();
    if (t) this.viewer.rename(t);
    this.renaming.set(false);
  }

  download(): void {
    const d = this.viewer.doc();
    if (!d) return;
    this.docsSvc.download(d.id).subscribe({
      next: (blob) => saveBlob(blob, `${d.title}.pdf`),
      error: () => this.toast.error('Download failed'),
    });
  }

  // --- versions ---
  revert(seq: number): void {
    this.busy.set(true);
    // Track the revert job to completion (viewer.revert only creates it).
    this.jobs.dispatch(this.viewer.revert(seq)).subscribe({
      next: (job) => this.trackReload(job, `Reverted to v${seq}`),
      error: () => this.fail(),
    });
  }

  // --- operations ---
  selected(): number[] {
    return this.pages.selectedSorted();
  }

  rotate(): void {
    this.requireSelection((sel) => this.runOp('rotate_pages', { pages: sel, degrees: 90 }, `Rotated ${sel.length} page(s)`));
  }

  async remove(): Promise<void> {
    const sel = this.selected();
    if (!sel.length) return this.needSelection();
    if (await this.confirm.ask(`Delete ${sel.length} page(s)?`, 'Delete')) {
      this.runOp('delete_pages', { pages: sel }, `Deleted ${sel.length} page(s)`);
    }
  }

  duplicate(): void {
    this.requireSelection((sel) => this.runOp('duplicate_pages', { pages: sel }, 'Duplicated pages'));
  }

  extract(): void {
    this.requireSelection((sel) =>
      this.runOpDocs('extract_pages', { pages: sel, as_new_document: true }, 'Extracted pages'),
    );
  }

  applyInsert(): void {
    this.runOp('insert_blank', { at_index: this.insertAt(), count: this.insertCount(), size: 'a4' }, 'Inserted blank page(s)');
    this.dialog.set(null);
  }

  applyScale(): void {
    const sel = this.selected().length ? this.selected() : this.order();
    this.runOp('scale_pages', { pages: sel, target_size: this.scaleSize() }, 'Scaled pages');
    this.dialog.set(null);
  }

  applyNup(): void {
    this.runOp('nup', { per_sheet: this.nupPer() }, `${this.nupPer()}-up layout`);
    this.dialog.set(null);
  }

  applyCompress(): void {
    this.runOp('compress', { preset: this.compressPreset() }, 'Compressed');
    this.dialog.set(null);
  }

  applySplit(): void {
    const params: Record<string, unknown> = { mode: this.splitMode() };
    if (this.splitMode() === 'ranges') params['ranges'] = this.splitRanges();
    if (this.splitMode() === 'every_n') params['every_n'] = this.splitEveryN();
    this.runOpDocs('split', params, 'Split document');
    this.dialog.set(null);
  }

  private requireSelection(fn: (sel: number[]) => void): void {
    const sel = this.selected();
    if (!sel.length) return this.needSelection();
    fn(sel);
  }

  private needSelection(): void {
    this.toast.info('Select one or more pages first');
  }

  private runOp(type: string, params: unknown, label: string): void {
    const d = this.viewer.doc();
    if (!d) return;
    this.busy.set(true);
    this.pages.dispatch(d.id, type, params, this.viewer.currentSeq()).subscribe({
      next: (job) => this.trackReload(job, label),
      error: () => this.fail(),
    });
  }

  private runOpDocs(type: string, params: unknown, label: string): void {
    const d = this.viewer.doc();
    if (!d) return;
    this.busy.set(true);
    this.pages.dispatch(d.id, type, params, this.viewer.currentSeq()).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          const docs = (job.result?.['documents'] as string[]) ?? [];
          this.toast.success(`${label} — ${docs.length} document(s)`);
          this.busy.set(false);
          if (docs.length) this.router.navigate(['/app/doc', docs[0]]);
        } else if (job.status === 'failed') {
          this.handleFailure(job);
        }
      },
      error: () => this.fail(),
    });
  }

  private trackReload(job: Job, label: string): void {
    if (job.status === 'succeeded') {
      this.toast.success(label);
      this.pages.clear();
      this.viewer.reload();
      this.busy.set(false);
    } else if (job.status === 'failed') {
      this.handleFailure(job);
    }
  }

  private handleFailure(job: Job): void {
    if (job.error_code === 'version_conflict') {
      this.toast.info('Document changed — refreshed');
      this.viewer.reload();
    } else {
      this.toast.error(job.error_message || 'Operation failed');
    }
    this.busy.set(false);
  }

  private fail(): void {
    this.toast.error('Operation failed');
    this.busy.set(false);
  }

  applyDialog(): void {
    switch (this.dialog()) {
      case 'split': return this.applySplit();
      case 'compress': return this.applyCompress();
      case 'scale': return this.applyScale();
      case 'nup': return this.applyNup();
      case 'insert': return this.applyInsert();
      default: return;
    }
  }

  async confirmRevert(seq: number): Promise<void> {
    if (await this.confirm.ask(`Revert to version ${seq}? This creates a new head version.`, 'Revert')) {
      this.revert(seq);
    }
  }

  submitPassword(pw: string): void {
    this.passwordPrompt.set(false);
    // One place: the viewer reads it from here through `password()`, and every
    // *operation* carries it too, so nothing prompts again (phase-07).
    const doc = this.viewer.doc();
    if (doc && pw) this.security.remember(doc.id, pw);
  }

  /** Protect/redact/sanitize produced a new version. */
  onProtectSaved(): void {
    this.viewer.reload();
  }

  /**
   * Redaction with "put the result in a new document" — the default, because
   * this document's earlier versions still contain what was removed.
   */
  onRedactedCopy(docId: string): void {
    // Land on the *document*, not on the redaction panel of a different one:
    // the work is finished, and what the user wants now is to look at it.
    this.mode.set('view');
    this.protectTab.set('protect');
    this.router.navigate(['/app/doc', docId]);
  }

  /** The Protect tool's own unlock box succeeded, or the top-level prompt did. */
  openProtect(tab: ProtectTab = 'protect'): void {
    this.protectTab.set(tab);
    this.mode.set('protect');
  }

  /**
   * Crop moved off the margin dialog onto the overlay (Human review queue,
   * 2026-07-19): you now drag the area to keep, on the page, instead of typing
   * a percentage and hoping. The organize selection carries over as the range.
   */
  startCrop(): void {
    this.annotateTool.set('crop');
    this.cropReturnsToOrganize = true;
    this.mode.set('annotate');
  }

  /** Annotate mode produced a new version (save, flatten or overlay crop). */
  onAnnotationsSaved(): void {
    this.viewer.reload();
  }

  /** Edit mode produced a new version. */
  onEditSaved(): void {
    this.viewer.reload();
  }

  /** Forms mode produced a new version (fill, flatten, import or field edits). */
  onFormsSaved(): void {
    this.viewer.reload();
  }

  /**
   * The scanned-page gate's CTA (phase-04), live since Phase 6 landed OCR:
   * the editor refuses a scan and this is the way out of that refusal, so it
   * hands straight to the OCR panel rather than explaining where to find it.
   */
  onOcrRequested(): void {
    this.fromScannedGate.set(true);
    this.mode.set('convert');
  }

  /** True when Convert was opened *from* the scanned-page gate, so the OCR
   *  panel can lead with why the editor sent them here. */
  cameFromScannedGate(): boolean {
    return this.fromScannedGate();
  }

  /** Convert/OCR/repair produced a new version. */
  onConvertSaved(): void {
    this.viewer.reload();
  }

  /**
   * The overlay crop finished. Crop is an Organize operation that borrows the
   * overlay, so it hands the user back where they came from — and the tool is
   * reset, or the next visit to Annotate would open on Crop forever.
   */
  onCropApplied(): void {
    this.viewer.reload();
    this.annotateTool.set('select');
    if (this.cropReturnsToOrganize) {
      this.cropReturnsToOrganize = false;
      this.mode.set('organize');
    }
  }

  /**
   * Autosave on navigation (phase-03 §2: "autosave every 30 s / on navigation").
   *
   * Called by the route guard. Navigation is not an exit, so it does not
   * interrogate the user — it commits the work and lets them go. Closing the
   * tab is the exit case, and that is what the `beforeunload` guard covers.
   */
  confirmLeave(): boolean {
    const doc = this.viewer.doc();
    if (!doc || !this.annotations.dirty()) return true;
    const job$ = this.annotations.save(doc.id, this.viewer.currentSeq());
    if (job$) {
      this.toast.info('Saving your annotations…');
      job$.subscribe({
        next: (job) => {
          if (job.status === 'failed') this.toast.error('Could not save your annotations');
        },
        error: () => this.toast.error('Could not save your annotations'),
      });
    }
    return true;
  }

  /**
   * A save lost a `version_conflict`. The drafts were kept, so reload the
   * document and let the user press Save again against the fresh version
   * (phase-03 §"Save model UX" — no merge dialog in v1).
   */
  onAnnotationConflict(): void {
    this.viewer.reload();
  }
}
