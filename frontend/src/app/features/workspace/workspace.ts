import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgxExtendedPdfViewerModule } from 'ngx-extended-pdf-viewer';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { AuthFacade } from '../../abstraction/auth.facade';
import { CompareFacade } from '../../abstraction/compare.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { PagesFacade } from '../../abstraction/pages.facade';
import { SecurityFacade } from '../../abstraction/security.facade';
import { ViewerFacade } from '../../abstraction/viewer.facade';
import { Job, SearchHit } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { GuestTokenService } from '../../core/services/guest-token.service';
import { ThemeService } from '../../core/services/theme.service';
import { TokenService } from '../../core/services/token.service';
import { Brand } from '../../shared/brand';
import { ConfirmService } from '../../shared/confirm.service';
import { GuestBanner } from '../../shared/guest-banner';
import { ZenModal } from '../../shared/modal.directive';
import { PdfThumbnail } from '../../shared/pdf-thumbnail';
import { ShortcutsHelp } from '../../shared/shortcuts-help';
import { resolveShortcut, shortcutTitle } from '../../shared/shortcuts';
import { ThemeToggle } from '../../shared/theme-toggle';
import { saveBlob } from '../../shared/save-blob';
import { Spinner } from '../../shared/spinner';
import { ToastService } from '../../shared/toast.service';
import { Annotate, AnnotateTool } from './annotate';
import { Compare } from './compare';
import { Convert } from './convert';
import { Edit } from './edit';
import { Forms } from './forms';
import { Protect, ProtectTab } from './protect';
import { Sign } from './sign';

// `crop` left the dialog list in Phase 3: it is now drawn on the overlay
// (Human review queue, 2026-07-19 — "revisit crop to use it then").
type Dialog = null | 'split' | 'scale' | 'nup' | 'compress' | 'insert';

@Component({
  selector: 'app-workspace',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, RouterLink, NgxExtendedPdfViewerModule, CdkDropList, CdkDrag, PdfThumbnail,
    Annotate, Edit, Forms, Convert, Compare, Protect, Sign, ZenModal, Spinner,
    Brand, GuestBanner, ThemeToggle, ShortcutsHelp,
  ],
  templateUrl: './workspace.html',
  // The host is a flex item of the shell's `main`, and it was not saying so:
  // an inline element with `height: auto` around a child asking for `h-full`
  // is circular, so the whole workspace sized itself to its content. On a
  // 900px screen the reading pane came out 318px tall with 400px of empty
  // backdrop under it, in every mode.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
})
export class Workspace {
  protected viewer = inject(ViewerFacade);
  protected pages = inject(PagesFacade);
  protected themes = inject(ThemeService);
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
  protected auth = inject(AuthFacade);
  private destroyRef = inject(DestroyRef);

  protected leftTab = signal<'thumbs' | 'outline' | 'history'>('thumbs');
  protected mode = signal<
    'view' | 'organize' | 'annotate' | 'edit' | 'forms' | 'convert' | 'compare'
    | 'protect' | 'sign'
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
  protected shortcutsOpen = signal(false);
  protected readonly key = shortcutTitle;
  protected splitMode = signal<'ranges' | 'every_n' | 'by_size_mb' | 'by_bookmarks'>('ranges');
  protected splitRanges = signal('1');
  protected splitEveryN = signal(1);
  protected scaleSize = signal<'a4' | 'letter' | 'legal'>('a4');
  protected nupPer = signal(2);
  protected compressPreset = signal<'light' | 'balanced' | 'strong'>('balanced');
  protected insertAt = signal(1);
  protected insertCount = signal(1);

  /** Which document is open, as a value — see the annotate effect below. */
  private readonly openDocId = computed(() => this.viewer.doc()?.id ?? null);

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

  /**
   * Bumped when a viewer fetch is retried after a token refresh (L10).
   *
   * `src` has to *change* for the viewer to fetch again, and after a refresh
   * the URL is byte-for-byte what it was — only the header differs.
   */
  private viewerAttempt = signal(0);
  /**
   * The document id the viewer's one refresh-retry has been spent on.
   *
   * One retry *per document*, not per component: the workspace is reused across
   * `/app/doc/:id` navigations (split and extract land on a new one), so a
   * boolean meant the second document in a session got no recovery at all.
   */
  private viewerRetriedFor: string | null = null;

  readonly contentUrl = computed(() => {
    const d = this.viewer.doc();
    // Pinning the URL to the version seq is what makes `src` change after an
    // operation — without it the viewer keeps rendering the old bytes.
    if (!d?.current_version) return '';
    const url = this.docsSvc.contentUrl(d.id, d.current_version.seq);
    const attempt = this.viewerAttempt();
    return attempt ? `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}` : url;
  });
  /**
   * The `src` whose **first page has actually painted**.
   *
   * The viewer being present, the requests answering 200 and the document
   * loading are three things that were all true throughout the ten days
   * `/app/doc/:id` rendered nothing in production (queue, 2026-08-10). None of
   * them is "a page drew", and `pdfLoaded` is not either — the library reports
   * the document parsed, before any canvas exists. `pageRendered` fires once
   * per page *after* pdf.js has painted it, which is the event that means what
   * we need to assert.
   *
   * Storing the URL rather than a boolean makes the reset free and exact: the
   * claim is about the bytes currently in `src`, so a new version, a revert or
   * a refresh-retry (all of which change `contentUrl()`) withdraws it by
   * arithmetic, with nothing to remember to clear.
   */
  private drawnUrl = signal<string | null>(null);
  protected readonly pageDrawn = computed(
    () => !!this.drawnUrl() && this.drawnUrl() === this.contentUrl(),
  );

  /** pdf.js painted a page of the document currently in `src`. */
  protected onPageRendered(): void {
    this.drawnUrl.set(this.contentUrl());
  }

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
    // The one shortcut that belongs to the whole workspace rather than to a
    // mode: the sheet that says what the others are. It carries a modifier on
    // purpose — a bare `?` would be a single-character shortcut, which WCAG
    // 2.1 SC 2.1.4 only permits if it can be turned off or remapped, and
    // building a remapping UI to save one keypress is the wrong trade.
    effect((onCleanup) => {
      if (!this.isBrowser) return;
      const handler = (event: KeyboardEvent) => {
        if (resolveShortcut(event) !== 'help') return;
        event.preventDefault();
        this.openShortcuts();
      };
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
    });
    // Arm the countdown whenever a throttle arrives, and let it run down.
    effect((onCleanup) => {
      const wait = this.viewer.error()?.retryAfter ?? 0;
      this.retryIn.set(wait);
      if (!wait || !this.isBrowser) return;
      const timer = setInterval(() => {
        this.retryIn.update((left) => (left > 0 ? left - 1 : 0));
      }, 1000);
      onCleanup(() => clearInterval(timer));
    });
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
      // Every mode the bar offers, not a subset: `organize` and `view` were
      // missing, so `/app/doc/:id?mode=organize` quietly rendered the reading
      // view — and `/organize-pdf`, the tool whose entire subject is the page
      // grid, had no way to ask for it.
      const mode = params.get('mode');
      if (mode === 'view' || mode === 'organize' || mode === 'annotate' || mode === 'edit'
          || mode === 'forms' || mode === 'convert' || mode === 'compare'
          || mode === 'protect' || mode === 'sign') {
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
    // out of object storage and parses it in the API process. Ungated, every
    // View/Organize user would pay that cost on every open for a panel they
    // never touch.
    //
    // Keyed on the **id and the seq**, not on `viewer.doc()`. The document is a
    // new *object* after every refresh, so keying on it re-read the whole file
    // for changes that cannot possibly have altered an annotation — a rename,
    // for one. `adopt()` made that worse rather than exposing it: it advances
    // the seq when the save returns and then refreshes the document again when
    // the refetch lands, which under the old key was two full annotation reads
    // per save. A computed only notifies when its value actually changes, so
    // both the old waste and the new doubling go away together.
    effect(() => {
      if (this.mode() !== 'annotate') return;
      const id = this.openDocId();
      const seq = this.viewer.currentSeq();
      if (!id) return;
      this.annotations.resetForVersion();
      this.annotations.load(id, seq);
    });
    effect(() => {
      const doc = this.viewer.doc();
      // Not when the session already knows the password — including the case
      // where the user has just *chosen* it, which is no time to ask for it.
      // It closes as well as opens: removing the password forgets it, and a
      // prompt that only ever opened left one hanging over an unlocked
      // document with nothing left to unlock.
      this.passwordPrompt.set(
        !!doc?.is_encrypted && !this.security.isUnlocked(doc.id),
      );
    });
  }

  /**
   * The error state's "Try again".
   *
   * The id is still in the URL, so a transient failure — a dropped connection,
   * a 500 — costs a click rather than a navigation. Nothing to recover from a
   * 404, but offering the button there too beats deciding for the person which
   * of their failures was permanent.
   */
  protected retryLoad(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) this.viewer.load(id);
  }

  /**
   * Seconds left on a throttle, counted down so the button becomes true.
   *
   * A throttle is a pause, not a breakage: the server said exactly how long,
   * and offering "Try again" before then is offering the same failure again.
   */
  protected readonly retryIn = signal(0);
  private isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * The viewer could not fetch the document (L10).
   *
   * ngx-extended-pdf-viewer fetches outside `HttpClient`, so the auth
   * interceptor's refresh-and-retry never runs for it: an access token that
   * expired while the workspace was open gives a 401 and a blank pane, with a
   * perfectly good refresh token in storage. Refresh once and re-assign `src`
   * — `authHeaders()` recomputes off the token signal on its own.
   *
   * Once per document: a genuine 404 must not become a refresh loop, and a
   * guest has no refresh token to spend.
   */
  protected onViewerLoadFailed(): void {
    const docId = this.viewer.doc()?.id;
    if (!docId || this.viewerRetriedFor === docId) return;
    if (this.guests.principal() !== 'user') return;
    this.viewerRetriedFor = docId;
    this.auth.refreshAccess()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.viewerAttempt.update((n) => n + 1),
        error: () => this.toast.error('Could not load the document — try reloading the page.'),
      });
  }

  // --- selection / thumbnails ---
  onThumbClick(page: number, event: Event): void {
    // Enter/Space arrive as a plain Event from Angular's key pseudo-bindings;
    // both a mouse and a keyboard event carry the modifier flags we read.
    const mods = event as MouseEvent | KeyboardEvent;
    if (this.mode() === 'organize') {
      if (mods.shiftKey) {
        this.pages.selectRange(page);
      } else {
        this.pages.toggle(page, mods.ctrlKey || mods.metaKey);
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
  /**
   * Undo the last change to the file.
   *
   * Every edit here is a server op that appends a version, so "undo" already
   * existed — buried three clicks deep as "Revert to this" on a row of the
   * History tab, which is not where anybody looks after a mistake. This is the
   * same operation with the name people expect, in the bar that owns every
   * editing affordance (§4 workspace, D3). It is itself a new version, so it
   * can be undone in turn, which is why it does not stop to ask.
   */
  /**
   * Where the undo chain is, when there is one (phase-12 D11).
   *
   * A revert *appends*, so after one Undo the version whose content is on
   * screen and `currentSeq()` are two different numbers — and the first cut of
   * this button ignored that. `undoLastChange` always reverted to
   * `currentSeq() - 1`: at v5 that is v4, correctly; but the revert makes v6,
   * so pressing Undo again reverted to **v5 — the change just undone**. Undo
   * was single-shot and silently became Redo on the second press.
   *
   * `content` is the version actually being shown, `ceiling` the one the chain
   * started from (so Redo cannot walk forward past where the user was), and
   * `expected` is what `currentSeq()` must equal for the chain to still be
   * live. Any other operation appends a version, `expected` stops matching, and
   * the chain ends by arithmetic — no invalidation to wire up and forget.
   */
  private versionCursor = signal<{ ceiling: number; content: number; expected: number } | null>(null);

  /** The version whose content is on screen. */
  private readonly shownSeq = computed(() => {
    const cursor = this.versionCursor();
    const seq = this.viewer.currentSeq() ?? 1;
    return cursor && cursor.expected === seq ? cursor.content : seq;
  });

  protected readonly canUndoVersion = computed(() => this.shownSeq() > 1);

  protected readonly canRedoVersion = computed(() => {
    const cursor = this.versionCursor();
    if (!cursor || cursor.expected !== (this.viewer.currentSeq() ?? 1)) return false;
    return cursor.content < cursor.ceiling;
  });

  protected readonly undoTarget = computed(() => this.shownSeq() - 1);
  protected readonly redoTarget = computed(() => this.shownSeq() + 1);

  /**
   * Focus the button *before* opening the sheet.
   *
   * `ZenModal` restores focus to whatever was active when it was constructed,
   * and for a sheet opened by a keystroke that is usually `<body>` — whose
   * `focus()` is a no-op, so closing would drop focus to the top of the
   * document. Focusing the control that represents this action first makes the
   * restore land somewhere a person can carry on from.
   */
  protected openShortcuts(): void {
    if (this.isBrowser) {
      document.querySelector<HTMLElement>('[data-test=shortcuts-open]')?.focus();
    }
    this.shortcutsOpen.set(true);
  }

  protected undoLastChange(): void {
    if (!this.canUndoVersion()) return;
    this.stepVersion(this.undoTarget());
  }

  protected redoLastChange(): void {
    if (!this.canRedoVersion()) return;
    this.stepVersion(this.redoTarget());
  }

  private stepVersion(target: number): void {
    const seq = this.viewer.currentSeq() ?? 1;
    const cursor = this.versionCursor();
    const live = cursor && cursor.expected === seq;
    this.versionCursor.set({
      ceiling: live ? cursor.ceiling : seq,
      content: target,
      // The revert appends exactly one version.
      expected: seq + 1,
    });
    this.revert(target);
  }

  revert(seq: number): void {
    this.busy.set(true);
    // Track the revert job to completion (viewer.revert only creates it).
    this.jobs.dispatch(this.viewer.revert(seq))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
    this.pages.dispatch(d.id, type, params, this.viewer.currentSeq())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (job) => this.trackReload(job, label),
      error: () => this.fail(),
    });
  }

  private runOpDocs(type: string, params: unknown, label: string): void {
    const d = this.viewer.doc();
    if (!d) return;
    this.busy.set(true);
    this.pages.dispatch(d.id, type, params, this.viewer.currentSeq())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
      this.viewer.adopt(job);
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

  /**
   * The six "a mode produced a new version" handlers.
   *
   * Each takes the `Job` its panel emitted and hands it to
   * `ViewerFacade.adopt`, which reads the new `seq` out of the result before
   * kicking off the refetch. Until 2026-08-22 every one of these was a bare
   * `this.viewer.reload()` and the template dropped the `$event` — so for the
   * length of one GET after every save, `currentSeq()` was a version behind and
   * the next operation dispatched a stale `base_version_seq` straight into a
   * `version_conflict`. The panels were never the problem: all six have emitted
   * `output<Job>()` since Phase 3. The receiver was throwing it away.
   */
  onProtectSaved(job: Job): void {
    this.viewer.adopt(job);
  }

  /** Self-sign produced a new version. */
  onSigned(job: Job): void {
    this.viewer.adopt(job);
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
  onAnnotationsSaved(job: Job): void {
    this.viewer.adopt(job);
  }

  /** Edit mode produced a new version. */
  onEditSaved(job: Job): void {
    this.viewer.adopt(job);
  }

  /** Forms mode produced a new version (fill, flatten, import or field edits). */
  onFormsSaved(job: Job): void {
    this.viewer.adopt(job);
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
  onConvertSaved(job: Job): void {
    this.viewer.adopt(job);
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
