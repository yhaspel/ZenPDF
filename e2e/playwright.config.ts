import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright projects and suites (phase-10 §10.5).
 *
 * Two suites, selected by tag rather than by file, so a spec moves between
 * them by editing its title:
 *
 *   npx playwright test --grep @smoke   # ~40 s: the paths that must never break
 *   npx playwright test                 # everything ("@full") — what `infra/test.sh --e2e` runs (there is no CI; docs/ops/release.md)
 *
 * `@smoke` is the deploy gate: register, upload, run an operation, self-sign
 * as a guest, complete a two-signer ceremony, and the public pages'
 * accessibility floor. If those pass, the product works; if one fails, nothing
 * else matters. There is no `@full` *tag* — "full" is the whole suite, i.e.
 * this file with no `--grep`, which is what makes it impossible to forget to
 * tag a new spec into it.
 *
 * **Cross-browser is opt-in** (`BROWSERS=all`) rather than the default. Three
 * engines on every run triples a suite that already drives real PDFs through a
 * real worker, and the failures we have actually hit are logic, not engine.
 * The nightly `@full` run sets it — see docs/ops/release.md.
 *
 * Retries: **zero, deliberately.** A flaky test that passes on retry is a
 * flaky product nobody looks at; §10.5 asks for a quarantine tag and a fix,
 * not a retry count.
 *
 * `@quarantine` is that tag, and until 2026-08-22 it did nothing at all — the
 * config never mentioned it, so a "quarantined" spec ran with everything else
 * and failed the gate exactly as before. It excludes the spec now:
 *
 *   npx playwright test                      # @quarantine excluded
 *   INCLUDE_QUARANTINE=1 npx playwright test # everything, to see if it is fixed
 *
 * The tag is a debt marker with a name attached, not a retry in disguise:
 * excluding a spec hides a real failure, so it is only ever correct with a
 * queue row saying what is broken and who owns it. **Nothing carries the tag
 * today**, which is the state to keep.
 */
const allBrowsers = process.env['BROWSERS'] === 'all';
const includeQuarantine = process.env['INCLUDE_QUARANTINE'] === '1';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  ...(includeQuarantine ? {} : { grepInvert: /@quarantine/ }),
  reporter: [['list']],
  use: {
    baseURL: process.env['BASE_URL'] ?? 'http://localhost:4200',
    headless: true,
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  projects: allBrowsers
    ? [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        // The surface people actually reach on a phone from somebody else: the
        // signing ceremony. `@mobile` only — **not `@mobile|@smoke`**, which is
        // what this said until 2026-08-25 and which never matched the sentence
        // above it.
        //
        // `@smoke` swept in specs written for the desktop layout, and they did
        // not fail for an engine reason: `phase-1` asserts
        // `[data-test=rail-thumb]` is visible, and on a phone the thumbnail
        // rail is a **closed bottom sheet** by design (the phone workspace,
        // PR #31) — measured `hidden`, in isolation, on both mobile projects.
        // `phase-2b` drives the same desktop-shaped flow. So five of the eight
        // `BROWSERS=all` failures on 2026-08-25 were this grep asking two
        // phone projects to prove a desktop layout, which is coverage that
        // could only ever be red.
        //
        // The phone's real coverage is deliberately *not* here:
        // `phase-10-mobile.spec.ts` pins an exact 390 × 844 viewport and stays
        // out of these projects on purpose, because `devices[…]` sets
        // `isMobile: true` and that emulation is the instrument that hid the
        // 2026-08-21 overflow. Read that file's header before widening this.
        { name: 'mobile-chrome', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
        { name: 'mobile-safari', use: { ...devices['iPhone 14'] }, grep: /@mobile/ },
      ]
    : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
