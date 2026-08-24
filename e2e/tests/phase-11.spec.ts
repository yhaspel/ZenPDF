import { Page, expect, test } from '@playwright/test';

/**
 * Phase 11 — the trust and editorial surfaces (§11B, §11C).
 *
 * What this suite is actually guarding: three new public routes, a footer that
 * went from five links to seven, and one invariant that is easy to break by
 * being helpful — the **ceremony's footer does not gain them**.
 */

/** The site footer, in the order the design contract fixes (§3). */
const FOOTER = [
  ['footer-about', '/about'],
  ['footer-privacy', '/legal/privacy'],
  ['footer-terms', '/legal/terms'],
  ['footer-esign', '/legal/esign-disclosure'],
  ['footer-verify', '/verify'],
  ['footer-contact', '/contact'],
  ['footer-guides', '/guides'],
] as const;

/**
 * The e2e stack serves the frontend with `ng serve` (infra/docker-compose.yml
 * `web`, target `dev`), and a dev server answers every unknown path with the
 * SPA shell and a **200**. Production does not: nginx's `error_page 404
 * /index.html` serves the shell while keeping the 404 status. So the status
 * assertion is only meaningful against a production-shaped origin, and saying
 * so out loud beats asserting 200 and calling it a pass.
 */
const isDevServer = (process.env['BASE_URL'] ?? 'http://localhost:4200').includes(':4200');

async function footerLinks(page: Page): Promise<string[]> {
  return page
    .locator('[data-test=site-footer] a')
    .evaluateAll((links) => links.map((a) => a.getAttribute('data-test') ?? ''));
}

test('phase 11: every site-footer link works, from every kind of public page', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Landing, a tool page and a legal page — three different components that
  // each embed the shared footer, so a link that works on one and not the
  // others would mean somebody rebuilt it locally.
  for (const from of ['/', '/merge-pdf', '/legal/privacy']) {
    await page.goto(from);
    expect(await footerLinks(page), `footer on ${from}`).toEqual(FOOTER.map(([t]) => t));

    for (const [testId, href] of FOOTER) {
      await page.goto(from);
      await page.locator(`[data-test=${testId}]`).click();
      await expect(page, `${testId} from ${from}`).toHaveURL(new RegExp(`${href}/?$`));
      // Not a 404 wearing the right URL.
      await expect(page.locator('[data-test=not-found]')).toHaveCount(0);
    }
  }
});

test('phase 11: the ceremony keeps its own footer and does not gain the two new links',
  async ({ page }) => {
  // Any ceremony screen carries the footer — it sits outside the screen
  // `@switch` — so an unknown token reaches it without needing an envelope.
  await page.goto('/s/not-a-real-token');
  const footer = page.locator('footer').last();
  await expect(footer).toBeVisible();

  const links = await footer
    .locator('a, button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-test') ?? ''));
  expect(links).toEqual([
    'footer-about',
    'footer-privacy',
    'footer-terms',
    'footer-esign',
    'report-open',
  ]);
  // The invariant this test exists for.
  expect(links).not.toContain('footer-contact');
  expect(links).not.toContain('footer-guides');
  // And the §10 verbatim sentence is still under it.
  await expect(footer).toContainText('not a qualified electronic signature');
});

test('phase 11: /contact offers an address and no form', async ({ page }) => {
  await page.goto('/contact');
  await expect(page.locator('[data-test=legal-h1]')).toHaveText('Contact');

  const mailto = page.locator('[data-test=contact-mailto]');
  await expect(mailto).toBeVisible();
  const href = await mailto.getAttribute('href');
  expect(href).toMatch(/^mailto:.+@.+\..+$/);
  // The link text is the address itself, so it can be copied by somebody whose
  // browser has no mail handler registered.
  expect(await mailto.innerText()).toBe(href!.replace('mailto:', ''));

  // No form: SMTP is off by owner decision, and a form would send nothing.
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('input, textarea, button[type=submit]')).toHaveCount(0);

  // The reading column, not the `.sheet` the contract reserves for trust
  // notices and empty states.
  await expect(page.locator('main.wrap-reading')).toBeVisible();
  await expect(page.locator('.sheet')).toHaveCount(0);
});

test('phase 11: /about answers who runs this and links /contact', async ({ page }) => {
  await page.goto('/about');
  await expect(page.locator('[data-test=about-identity]')).toContainText('independent product');
  await page.locator('[data-test=about-contact-link]').click();
  await expect(page).toHaveURL(/\/contact\/?$/);
});

test('phase 11: /guides lists twelve guides and every link opens one', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/guides');
  await expect(page.locator('[data-test=guides-h1]')).toHaveText('Guides');

  const rows = page.locator('[data-test^=guide-link-]');
  await expect(rows).toHaveCount(12);

  const hrefs = await rows.evaluateAll((links) =>
    links.map((a) => a.getAttribute('href') ?? ''),
  );
  expect(new Set(hrefs).size).toBe(12);

  for (const href of hrefs) {
    await page.goto(href);
    // A real article, not the SPA shell or a 404 wearing the right URL.
    await expect(page.locator('[data-test=guide-h1]')).toBeVisible();
    await expect(page.locator('[data-test=guide-section]').first()).toBeVisible();
    await expect(page.locator('[data-test=guide-byline]')).toContainText('the ZenPDF team');
    await expect(page.locator('[data-test=not-found]')).toHaveCount(0);
  }
});

test('phase 11: a guide’s related-tool links resolve to real tool pages', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/guides/what-is-ocr-make-a-scanned-pdf-searchable');

  const cards = page.locator('[data-test^=guide-tool-]');
  await expect(cards).toHaveCount(4);
  const hrefs = await cards.evaluateAll((links) =>
    links.map((a) => a.getAttribute('href') ?? ''),
  );

  for (const href of hrefs) {
    await page.goto(href);
    // Every one has to be a working tool page — an H1 and a dropzone, which is
    // what §21.6 means by "the page is itself the tool".
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('[data-test=file-input]')).toHaveCount(1);
    await expect(page.locator('[data-test=not-found]')).toHaveCount(0);
  }

  // The caution on the e-signature guide, and its link out, per §3/§4.
  await page.goto('/guides/are-electronic-signatures-legally-binding');
  const note = page.locator('[data-test=guide-note]');
  await expect(note).toBeVisible();
  await expect(note).toContainText('not legal advice');
  await note.locator('[data-test=guide-note-link]').click();
  await expect(page).toHaveURL(/\/legal\/esign-disclosure\/?$/);
});

test('phase 11: an unknown guide slug is a real 404, not an empty article',
  async ({ page }) => {
  const response = await page.goto('/guides/does-not-exist');

  // The page, which is the half that holds on any server: the router must fall
  // through to NotFound rather than rendering a guide with nothing in it. This
  // is what would break if `guides/<slug>` were ever made parameterised.
  await expect(page.locator('[data-test=not-found]')).toBeVisible();
  await expect(page.locator('[data-test=guide-h1]')).toHaveCount(0);
  await expect(page.locator('[data-test=guide-section]')).toHaveCount(0);

  // The status, which only a production-shaped origin can express.
  test.skip(
    isDevServer,
    'ng serve answers every unknown path 200 with the SPA shell; nginx keeps the 404 ' +
      '(error_page 404 /index.html). Run with BASE_URL pointed at the built image.',
  );
  expect(response?.status()).toBe(404);
});
