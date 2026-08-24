import { MediaMatcher } from '@angular/cdk/layout';

/**
 * A `MediaMatcher` a test can resize (design contract §3 Phone workspace).
 *
 * The phone workspace is a breakpoint, and a breakpoint cannot be asserted by
 * setting `window.innerWidth` — jsdom will not re-evaluate a media query, and a
 * real `matchMedia` in a headless browser answers about the *runner's* window.
 * So the seam is CDK's `MediaMatcher`, which is the one thing the shell facade
 * asks, and this replaces it.
 *
 * Lives in `src` rather than beside one spec because three specs need it: the
 * drawer's, the bottom bar's and the workspace's own.
 */
export class FakeMediaMatcher implements Pick<MediaMatcher, 'matchMedia'> {
  private listeners: ((event: MediaQueryListEvent) => void)[] = [];
  private readonly list: MediaQueryList;

  constructor(private narrow = false) {
    // Closures rather than `this` inside the literal: `matches` has to be a
    // *getter*, because the facade reads the list once and keeps it, and a
    // snapshot would make `resize()` invisible to it.
    const matches = (): boolean => this.narrow;
    const listen = (fn: (event: MediaQueryListEvent) => void): void => {
      this.listeners.push(fn);
    };
    this.list = {
      get matches(): boolean {
        return matches();
      },
      media: '(max-width: 767px)',
      addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void): void => listen(fn),
      removeEventListener: (): void => undefined,
    } as unknown as MediaQueryList;
  }

  matchMedia(): MediaQueryList {
    return this.list;
  }

  /** Resize, the way the browser would: set, then notify. */
  resize(narrow: boolean): void {
    this.narrow = narrow;
    for (const fn of this.listeners) fn({ matches: narrow } as MediaQueryListEvent);
  }
}
