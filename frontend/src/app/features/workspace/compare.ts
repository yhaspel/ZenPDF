import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { CompareFacade, ChangeRow } from '../../abstraction/compare.facade';
import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { DocumentModel } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { OverlayItem } from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { ToastService } from '../../shared/toast.service';
import { WsDrawerHead } from '../../shared/ws-drawer-head';
import { WsDrawer } from '../../shared/ws-drawer';
import { FitWidth } from '../../shared/fit-width';
import { clampPageWidth } from '../../shared/page-fit';

/** The widest Compare ever draws either page — its desk width. */
const MAX_PAGE = 420;

/**
 * Compare mode (phase-06).
 *
 * Both sides are drawn with the Phase-3 overlay rather than two PDF viewers:
 * the change rectangles are §8 normalized, so drawing them over our own page
 * raster needs no conversion and no fighting with a viewer that owns its DOM.
 * "Synced" then means what it should — clicking a change moves *both* sides to
 * the page it is on and highlights it there.
 */
@Component({
  selector: 'app-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageOverlay, WsDrawer, WsDrawerHead, FitWidth],
  templateUrl: './compare.html',
  // Below `md` a mode's host has to be a growing flex item, or the column sizes
  // to its content and the bottom bar floats above the fold — `styles.scss`
  // §17c says it once, with the measurement. Inert at ≥ `md` (§10).
  host: { class: 'ws-pane-host' },
})
export class Compare {
  readonly docId = input.required<string>();
  readonly currentSeq = input<number | null>(null);

  protected compare = inject(CompareFacade);
  private docsSvc = inject(DocumentsService);
  private toast = inject(ToastService);
  private shell = inject(WorkspaceShellFacade);
  private destroyRef = inject(DestroyRef);

  protected candidates = signal<DocumentModel[]>([]);
  protected page = signal(0);
  protected zoom = signal(MAX_PAGE);

  /**
   * Two pages share the pane on a desk and take it in turns on a phone.
   *
   * A fixed 420 meant 2 × 420 + a 16 px gap — 856 px of content in a 375 px
   * pane. Stacking below `md` rather than halving 375 twice: at 171 px a side
   * neither copy is readable, and a comparison you cannot read is not one.
   */
  protected onFit(available: number): void {
    this.zoom.set(clampPageWidth(MAX_PAGE, available, {
      columns: this.shell.phone() ? 1 : 2,
      gap: 16,
    }));
  }
  protected view = signal<'all' | 'text' | 'visual'>('all');

  protected readonly rows = computed<ChangeRow[]>(() => {
    const view = this.view();
    return this.compare.changes().filter(
      (row) => view === 'all'
        || (view === 'visual' ? row.kind === 'visual' : row.kind !== 'visual'),
    );
  });

  /** The page pair currently on screen, honouring the alignment offset. */
  protected readonly pair = computed(() => {
    const report = this.compare.report();
    const index = this.page();
    const entry = report?.pages[index];
    return {
      a: entry?.a_page ?? null,
      b: entry?.b_page ?? null,
      count: report?.pages.length ?? 0,
    };
  });

  constructor() {
    // What the phone's bottom bar draws on this mode's behalf (design contract
    // §3 Phone workspace). Published rather than duplicated: below `md` the
    // page bar's own pair is `.ws-hoisted`, so exactly one of each is on screen.
    effect(() => this.shell.setPaneActions({
      primary: {
        label: 'Compare',
        disabled: this.compare.running(),
        run: () => this.run(),
      },
    }));
    this.destroyRef.onDestroy(() => this.shell.reset());

    effect(() => {
      // Candidates are the caller's *other* documents — compare is by
      // definition a two-document operation, and offering this one is noise.
      const id = this.docId();
      this.docsSvc.list({}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (page) => this.candidates.set(page.results.filter((d) => d.id !== id)),
        error: () => this.candidates.set([]),
      });
    });
  }

  protected overlayItems(side: 'a' | 'b'): OverlayItem[] {
    const pair = this.pair();
    const page = side === 'a' ? pair.a : pair.b;
    if (page === null) return [];
    const selected = this.compare.selectedId();
    return this.compare.rectsFor(side, page).map(({ id, rect }) => ({
      id,
      page,
      shape: 'rect' as const,
      rect,
      stroke: id === selected ? '#dc2626' : '#f59e0b',
      fill: id === selected ? '#fecaca' : '#fde68a',
      opacity: id === selected ? 0.55 : 0.3,
      width: id === selected ? 2 : 1,
    }));
  }

  protected run(): void {
    const job$ = this.compare.run(this.docId(), this.currentSeq());
    if (!job$) {
      this.toast.info('Choose a document to compare against');
      return;
    }
    job$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          this.page.set(0);
          const summary = this.compare.summary();
          const changed = summary?.changed_pages ?? 0;
          this.toast.success(
            summary?.identical
              ? 'No differences found'
              : `${changed} ${changed === 1 ? 'page differs' : 'pages differ'}`,
          );
        } else if (job.status === 'failed') {
          this.toast.error(job.error_message || 'Compare failed');
        }
      },
      error: () => this.toast.error('Compare failed'),
    });
  }

  /** Clicking a change moves both sides to its page and selects it. */
  protected goTo(row: ChangeRow): void {
    this.compare.select(row.id);
    this.page.set(row.pageIndex);
  }

  protected onOverlaySelect(id: string | null): void {
    if (!id) return;
    const row = this.compare.changes().find((r) => r.id === id);
    if (row) this.goTo(row);
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pair().count - 1, p + 1));
  }
}
