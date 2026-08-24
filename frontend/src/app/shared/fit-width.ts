import {
  DestroyRef, Directive, ElementRef, afterNextRender, inject, output,
} from '@angular/core';

/**
 * The usable inline size of a page pane's scroller, as an event.
 *
 * **Not the window, and not the document either.** The page does not live in
 * the window: it lives inside a scroller that has rails beside it on a desk
 * (Annotate's two take 208 + 256 + 2 px), padding of its own (`p-6`, or `p-4`
 * in Compare), and — on any browser that draws a classic scrollbar — a 15 px
 * gutter that no window or document metric reports. Below `md` the workspace
 * document cannot scroll at all (`.page-shell:has(app-workspace)` is `100dvh`),
 * so `innerWidth` and `documentElement.clientWidth` are the *same* number there
 * and both are 15 px too big. Only the element knows.
 *
 * `contentBoxSize[0].inlineSize` is exactly the number wanted — the padding box
 * less the scrollbar, less the inline padding — so nothing here has to know
 * which padding class the template chose. That is what a hardcoded `− 48` in a
 * different file was standing in for.
 *
 * Browser-only by construction: `afterNextRender` never runs on the server, and
 * `/app/**` is client-rendered anyway. A pane that is never measured keeps the
 * desk width its component was seeded with, which is the right answer where
 * there is no layout to fit.
 */
@Directive({ selector: '[zenFitWidth]' })
export class FitWidth {
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);

  /** The pane's content-box inline size, on first layout and on every change. */
  readonly fitWidth = output<number>();

  private last = -1;

  constructor() {
    afterNextRender(() => {
      // The unit environment has no `ResizeObserver`, and an error thrown in
      // `afterNextRender` does not stay local: it surfaced as 59 unhandled
      // errors across the suite and timed out an unrelated spec that only
      // builds the `Workspace` component. Degrading here is also the honest
      // behaviour — a pane that is never measured keeps the desk width its
      // component was seeded with, which is what a page gets anywhere there is
      // no layout to fit.
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(([entry]) => {
        const measured = Math.round(entry.contentBoxSize[0].inlineSize);
        // Only on a real change. A page fitted to its pane can make the pane's
        // own vertical scrollbar come and go, which changes the width by 15 px
        // and would otherwise feed straight back in; emitting only on change
        // makes that converge instead of ringing.
        if (measured > 0 && measured !== this.last) {
          this.last = measured;
          this.fitWidth.emit(measured);
        }
      });
      observer.observe(this.el.nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
