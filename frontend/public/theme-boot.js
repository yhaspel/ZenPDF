/**
 * FOUC prevention (design contract §5): resolve the stored theme before the
 * first paint of a prerendered page. Must stay ahead of the stylesheets and
 * mirror ThemeService's logic exactly.
 *
 * This lives in a file rather than inline in index.html on purpose. Production
 * serves `script-src 'self' 'wasm-unsafe-eval'` with no 'unsafe-inline' and no
 * hash, so an inline block is refused by the browser and the theme is never
 * applied before hydration — which is precisely what happened in production
 * until 2026-08-10. A same-origin file satisfies 'self' and needs no CSP change.
 *
 * Loaded as a classic, non-deferred <script> in <head>, so it still runs
 * synchronously before the document is painted.
 */
(function () {
  try {
    var stored = localStorage.getItem('zenpdf.theme');
    var pref = stored === 'light' || stored === 'dark' ? stored : 'system';
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var apply = function () {
      var dark = pref === 'dark' || (pref === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    // Follow OS changes while "system" is active, until Angular takes over.
    if (media.addEventListener) { media.addEventListener('change', apply); }
  } catch (e) { /* storage unavailable — system light it is */ }
})();
