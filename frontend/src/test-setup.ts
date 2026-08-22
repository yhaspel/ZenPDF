/**
 * Give the unit suite a `localStorage` that works.
 *
 * This is an **environment** repair, and it is deliberately separate from the
 * product fix in `app/core/browser-storage.ts`. The product fix teaches the
 * three storage-backed services to recognise a storage they cannot use. This
 * file makes sure the specs themselves have one they *can* use — eight of them
 * call `localStorage.clear()`, `setItem` and `getItem` directly, because what
 * they are asserting is a real round-trip through real storage (a token written
 * by another tab, an ad-consent choice that survives a reload).
 *
 * Why they need help: node 25 defines a `localStorage` global of its own — an
 * empty object with no methods unless the process was started with a valid
 * `--localstorage-file` — and in a jsdom-backed vitest run it is that one the
 * specs reach, not jsdom's complete `Storage`. On node 24 (production, the
 * containers, `infra/test.sh`) nothing here changes anything: the ambient
 * storage already answers `getItem`, and this file leaves it alone.
 *
 * It repairs only what is broken, so it cannot mask the bug it sits next to:
 * `browser-storage.spec.ts` builds its own half-present stub and asserts the
 * guard rejects it, rather than relying on whatever the host happens to have.
 */
function installMemoryStorage(name: 'localStorage' | 'sessionStorage'): void {
  const ambient = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (typeof ambient?.getItem === 'function') return;

  const entries = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(String(key)) ?? null,
    setItem: (key: string, value: string) => void entries.set(String(key), String(value)),
    removeItem: (key: string) => void entries.delete(String(key)),
    clear: () => entries.clear(),
  };

  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
  }
}

installMemoryStorage('localStorage');
installMemoryStorage('sessionStorage');
