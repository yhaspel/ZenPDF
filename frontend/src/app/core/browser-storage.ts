import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, inject } from '@angular/core';

/**
 * `localStorage`, or `null` when there is no *usable* one.
 *
 * Three services keep a credential or a preference in local storage, and all
 * three used to ask the same question the same wrong way:
 * `typeof localStorage === 'undefined'`. That is an **existence** check, and
 * existence stopped implying capability:
 *
 * 1. **Absent.** Under build-time prerendering there is no browser and no
 *    storage. `isPlatformBrowser` is how the rest of the app answers "am I in a
 *    browser", so it is how this answers it too — one question, one answer.
 * 2. **Half-present.** Node 25 defines a `localStorage` global unconditionally:
 *    a bare `{}` with no `getItem`, `setItem` or `clear` unless the process was
 *    started with a valid `--localstorage-file`. `typeof` says "there is
 *    storage", the next line calls `getItem`, and the whole prerender run dies
 *    with `TypeError: e?.getItem is not a function` — 29 routes on this Mac,
 *    and 110 unit tests with it. Production and the containers are on node 24
 *    and were never affected, which is exactly why it could sit unnoticed.
 *
 * So: ask the platform *and* feature-detect the method about to be called.
 * Either check alone is insufficient — the platform check passes for node's
 * half-storage under a browser-platform test, and the feature check alone would
 * happily hand a prerender pass a working storage that nothing should write to.
 *
 * A storage that exists and then *throws* on use — Safari private mode refuses
 * `setItem` — is a different failure and stays where it already was: in the
 * callers' `try`/`catch`. This function is about what is reachable, not about
 * what a reachable thing will do.
 */
export function usableLocalStorage(isBrowser: boolean): Storage | null {
  if (!isBrowser) return null;
  try {
    const store = localStorage;
    return typeof store?.getItem === 'function' ? store : null;
  } catch {
    // Accessing the global itself can throw when cookies are blocked.
    return null;
  }
}

/**
 * The injection-context half: read `PLATFORM_ID` once, at construction.
 *
 * `usableLocalStorage()` is called from property getters that run long after
 * injection, so the platform answer has to be captured while `inject()` is
 * still legal.
 */
export function inBrowser(): boolean {
  return isPlatformBrowser(inject(PLATFORM_ID));
}
