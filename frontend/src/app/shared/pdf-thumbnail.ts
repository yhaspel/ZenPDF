import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import { DocumentsService } from '../core/services/documents.service';

/** Fetches a thumbnail as an authed blob (img cannot send the JWT header). */
@Component({
  selector: 'app-pdf-thumbnail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as u) {
      <img [src]="u" [alt]="'page ' + (page() + 1)" class="h-full w-full object-contain" />
    } @else if (failed()) {
      <button type="button" (click)="retry()"
              class="flex h-full w-full flex-col items-center justify-center gap-1 bg-slate-100 text-slate-500 hover:bg-slate-200"
              [attr.aria-label]="'Preview of page ' + (page() + 1) + ' failed to load. Retry.'"
              data-test="thumb-failed">
        <span class="text-base" aria-hidden="true">↻</span>
        <span class="text-[10px] leading-none">Retry</span>
      </button>
    } @else {
      <div class="flex h-full w-full items-center justify-center bg-slate-100 text-slate-500"
           data-test="thumb-loading">
        <span class="text-xs">…</span>
      </div>
    }
  `,
})
export class PdfThumbnail implements AfterViewInit, OnDestroy {
  readonly docId = input.required<string>();
  readonly page = input(0);
  readonly width = input(240);
  readonly version = input<number | undefined>(undefined);

  protected url = signal<string | null>(null);
  /**
   * A failed tile looked exactly like a loading one (L9): both fell to the
   * `…` placeholder, so a rail that had run into the 429 the lazy-loading
   * comment below describes sat there apparently still working, for ever.
   * A distinct state means the person can see what happened and ask again.
   */
  protected failed = signal(false);
  /** Bumped by `retry()`; the fetch effect reads it, so it re-runs. */
  private attempt = signal(0);
  private current: string | null = null;
  private docsSvc = inject(DocumentsService);
  private host = inject(ElementRef<HTMLElement>);

  /**
   * Nothing is fetched until the tile is near the viewport.
   *
   * A 500-page document mounts 500 of these — 1 000 with Organize open, since
   * the rail and the grid each mount a full set — and every one used to fire
   * its own authed GET the moment it was constructed. Ten of them are on
   * screen. The other 490 requests bought nothing, cost 44 s through a
   * six-connection pool, and in production cost more than that: the user
   * throttle is 120/min, so everything past the hundred-and-twentieth is a
   * 429 — the rest of the rail never arrives, and the next thing the person
   * actually asks for is refused too.
   *
   * This is what was done instead of the virtual scroll §10.2 names. The
   * measurement is in PROGRESS's decision table: 500 tiles cost 27 MB of DOM,
   * which is nothing, and virtualizing the rail *would* have been safe — but
   * virtualizing the Organize grid, which is the drag surface, silently moves
   * the wrong page.
   *
   * The **parent** is observed, not the host: the host is inline and has no
   * box of its own, and every call site wraps it in the sized box that decides
   * whether the tile is on screen.
   *
   * `IntersectionObserver` is absent under SSR and in the unit-test DOM, so
   * `near` starts true there and the tile fetches immediately — the old
   * behaviour, which is what those environments want.
   */
  private readonly near = signal(typeof IntersectionObserver === 'undefined');
  private observer: IntersectionObserver | null = null;

  constructor() {
    effect((onCleanup) => {
      if (!this.near()) return;
      const id = this.docId();
      const page = this.page();
      const w = this.width();
      const v = this.version();
      this.attempt();  // the dependency that lets `retry()` re-run this
      const sub = this.docsSvc.thumbnailBlob(id, page, w, v).subscribe({
        next: (blob) => {
          this.revoke();
          this.current = URL.createObjectURL(blob);
          this.url.set(this.current);
          this.failed.set(false);
        },
        error: () => {
          this.url.set(null);
          this.failed.set(true);
        },
      });
      onCleanup(() => {
        sub.unsubscribe();
        this.revoke();
      });
    });
  }

  ngAfterViewInit(): void {
    if (this.near()) return;
    const el = this.host.nativeElement;
    this.observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        this.near.set(true);
        this.observer?.disconnect();
        this.observer = null;
      },
      // One screenful of lead time, so the rail fills ahead of the scroll
      // rather than behind it.
      { rootMargin: '400px' },
    );
    this.observer.observe(el.parentElement ?? el);
  }

  /** Ask again for a tile that failed — most often a 429 the rail earned. */
  protected retry(): void {
    this.failed.set(false);
    this.attempt.update((n) => n + 1);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  private revoke(): void {
    if (this.current) {
      URL.revokeObjectURL(this.current);
      this.current = null;
    }
  }
}
