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
import { Observable, defer, retry, switchMap, throwError, timer } from 'rxjs';

import { DocumentsService } from '../core/services/documents.service';
import { MAX_ATTEMPTS, ThumbnailScheduler } from '../core/services/thumbnail-scheduler';

/** Fetches a thumbnail as an authed blob (img cannot send the JWT header). */
@Component({
  selector: 'app-pdf-thumbnail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as u) {
      <img [src]="u" [alt]="'page ' + (page() + 1)" class="h-full w-full object-contain" />
    } @else if (failed()) {
      <button type="button" (click)="retry()"
              class="bg-surface text-ink-muted hover:bg-bg flex h-full w-full flex-col items-center justify-center gap-1"
              [attr.aria-label]="'Preview of page ' + (page() + 1) + ' failed to load. Retry.'"
              data-test="thumb-failed">
        <span class="text-base" aria-hidden="true">↻</span>
        <span class="text-[10px] leading-none">Retry</span>
      </button>
    } @else {
      <div class="bg-surface text-ink-faint flex h-full w-full items-center justify-center"
           role="status" [attr.aria-label]="'Loading preview of page ' + (page() + 1)"
           data-test="thumb-loading">
        <span class="text-xs" aria-hidden="true">…</span>
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
   *
   * A tile **backing off is not failed** (2026-08-23): while the automatic
   * retries below are still to come it stays in its loading state, because
   * that is what is true — the preview is on its way, just not yet. The failed
   * state is what is left when four attempts have been spent.
   */
  protected failed = signal(false);
  /** Bumped by `retry()`; the fetch effect reads it, so it re-runs. */
  private attempt = signal(0);
  private current: string | null = null;
  private docsSvc = inject(DocumentsService);
  private scheduler = inject(ThumbnailScheduler);
  // Not `inject(ElementRef<HTMLElement>)`, which reads as though it types the
  // host and does not — that is an instantiation expression, and `inject`
  // resolves it back to `ElementRef<any>`. Same emitted call either way.
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

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
      const sub = this.fetch(id, page, w, v).subscribe({
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

  /**
   * The fetch, with the rail's shared pause in front of it and a backoff behind.
   *
   * `defer` rather than a plain chain because `retry` resubscribes to what it
   * is given: the hold has to be read again on each attempt, or a tile that
   * waited out one window would walk straight into the next.
   *
   * A healthy rail pays nothing for this. `holdFor()` is 0 when nothing has
   * been refused, and zero skips the timer rather than deferring by a tick, so
   * the unthrottled case is the same call it always was.
   */
  private fetch(id: string, page: number, w: number, v: number | undefined): Observable<Blob> {
    return defer(() => {
      // The hold is read *before* the request is built, not after: nothing about
      // a tile that is waiting should exist yet.
      const hold = this.scheduler.holdFor();
      const ask = () => this.docsSvc.thumbnailBlob(id, page, w, v);
      return hold > 0 ? timer(hold).pipe(switchMap(ask)) : ask();
    }).pipe(
      retry({
        count: MAX_ATTEMPTS - 1,
        delay: (error: unknown, retryCount: number) => {
          // A 404 or a 423 is an answer, not a refusal: asking again is rude
          // and cannot change it. Those fail at once, as they always have.
          if (!this.scheduler.isRefusal(error)) return throwError(() => error);
          return timer(this.scheduler.refused(error, retryCount));
        },
      }),
    );
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
