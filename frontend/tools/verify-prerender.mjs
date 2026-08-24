/**
 * Verify the shipped artifact really is server-rendered (§20 DoD item 9, §21.6).
 *
 * Prerendering happens in `ng build` (outputMode: static), which is exactly
 * what nginx serves in production. The `ng serve` dev server returns the SPA
 * shell instead, so "is it server-rendered?" has to be asked of the build
 * output — this script asks it mechanically rather than by eye.
 *
 * Three kinds of surface, three sets of assertions (§21.6): tool pages carry
 * `FAQPage` + `SoftwareApplication`, guide articles carry `Article`, and the
 * content pages just have to exist with their own title. All of them need a
 * canonical, because two of them shipped without one once.
 *
 * Usage: npm run build && npm run verify:prerender
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSlugs } from './seo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/zenpdf-web/browser');

/** The table's own `title:` / `h1:` lines, so the assertion is against the
 *  source of truth rather than against a copy of it kept here. */
function tableOf(file) {
  const source = readFileSync(resolve(root, file), 'utf8');
  const unescape = (s) => s.replace(/\\'/g, "'");
  return {
    slugs: extractSlugs(source),
    titles: [...source.matchAll(/^\s*title:\s*'(.+)',$/gm)].map((m) => unescape(m[1])),
    h1s: [...source.matchAll(/^\s*h1:\s*'(.+)',$/gm)].map((m) => unescape(m[1])),
  };
}

const tools = tableOf('src/app/core/tool-pages.ts');
const guides = tableOf('src/app/core/guide-pages.ts');

const failures = [];
if (!existsSync(dist)) {
  failures.push(`no build output at ${dist} — run \`npm run build\` first`);
}

/** Read a prerendered route, or record why it could not be read. */
function pageAt(routePath, label) {
  const file = resolve(dist, routePath, 'index.html');
  if (!existsSync(file)) {
    failures.push(`${label}: not prerendered (missing ${routePath}/index.html)`);
    return null;
  }
  return readFileSync(file, 'utf8');
}

function checkCommon(html, label, { title, h1 }) {
  if (title && !html.includes(`<title>${title}</title>`)) {
    failures.push(`${label}: unique <title> not in the served HTML`);
  }
  if (h1 && !html.includes(h1)) {
    failures.push(`${label}: <h1> copy not in the served HTML`);
  }
  if (!html.includes('rel="canonical"')) {
    failures.push(`${label}: canonical link not in the served HTML`);
  }
}

// --- tool pages: FAQPage + SoftwareApplication ---
tools.slugs.forEach((slug, i) => {
  const html = pageAt(slug, slug);
  if (!html) return;
  checkCommon(html, slug, { title: tools.titles[i], h1: tools.h1s[i] });
  if (!html.includes('"@type":"FAQPage"')) {
    failures.push(`${slug}: FAQPage JSON-LD not in the served HTML`);
  }
  if (!html.includes('"@type":"SoftwareApplication"')) {
    failures.push(`${slug}: SoftwareApplication JSON-LD not in the served HTML`);
  }
});

// --- guide articles: Article ---
guides.slugs.forEach((slug, i) => {
  const label = `guides/${slug}`;
  const html = pageAt(label, label);
  if (!html) return;
  checkCommon(html, label, { title: guides.titles[i], h1: guides.h1s[i] });
  if (!html.includes('"@type":"Article"')) {
    failures.push(`${label}: Article JSON-LD not in the served HTML`);
  }
  // The prose is the whole point of these pages. A guide that prerenders its
  // chrome and leaves the body to hydration is a guide a crawler reads as
  // empty, which is the exact failure the editorial layer exists to avoid.
  if (!html.includes('data-test="guide-section"')) {
    failures.push(`${label}: no guide sections in the served HTML — body not prerendered`);
  }
});

// --- content pages: present, with their own title and a canonical ---
for (const [route, marker] of [
  ['guides', 'data-test="guides-index"'],
  ['contact', 'data-test="contact-mailto"'],
]) {
  const html = pageAt(route, `/${route}`);
  if (!html) continue;
  if (!html.includes('rel="canonical"')) {
    failures.push(`/${route}: canonical link not in the served HTML`);
  }
  if (!html.includes(marker)) {
    failures.push(`/${route}: content not in the served HTML (looked for ${marker})`);
  }
}

// Every guide has to be reachable from the index, or it is a page in the
// sitemap that nothing on the site links to.
const index = existsSync(resolve(dist, 'guides/index.html'))
  ? readFileSync(resolve(dist, 'guides/index.html'), 'utf8')
  : '';
for (const slug of guides.slugs) {
  if (index && !index.includes(`/guides/${slug}`)) {
    failures.push(`/guides: does not link ${slug}`);
  }
}

for (const artifact of ['sitemap.xml', 'robots.txt']) {
  if (!existsSync(resolve(dist, artifact))) {
    failures.push(`${artifact} missing from the build output`);
  }
}

if (failures.length) {
  console.error('verify-prerender FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(
  `verify-prerender: ${tools.slugs.length} tool pages server-rendered with unique ` +
    'title/H1, FAQ + SoftwareApplication JSON-LD, canonical; ' +
    `${guides.slugs.length} guides with unique title/H1, Article JSON-LD, canonical and ` +
    'prerendered prose, all linked from /guides; /guides and /contact rendered; ' +
    'sitemap and robots present.',
);
