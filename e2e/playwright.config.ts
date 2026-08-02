import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright projects and suites (phase-10 §10.5).
 *
 * Two suites, selected by tag rather than by file, so a spec moves between
 * them by editing its title:
 *
 *   npx playwright test --grep @smoke   # ~40 s: the paths that must never break
 *   npx playwright test                 # everything ("@full"), which is what CI runs
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
 */
const allBrowsers = process.env['BROWSERS'] === 'all';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
        // The two surfaces people actually reach on a phone: the ceremony
        // (sent to them by somebody else) and the dashboard.
        { name: 'mobile-chrome', use: { ...devices['Pixel 7'] },
          grep: /@mobile|@smoke/ },
        { name: 'mobile-safari', use: { ...devices['iPhone 14'] },
          grep: /@mobile|@smoke/ },
      ]
    : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
