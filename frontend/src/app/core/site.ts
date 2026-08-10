import { Meta } from '@angular/platform-browser';

/**
 * The site's public origin — the single place it is written down (§21.6).
 *
 * Everything that has to name the site absolutely reads it from here: the
 * `canonical` / `og:url` tags, the JSON-LD `url`, and — parsed out of this file
 * by `tools/generate-seo.mjs`, the same way the tool slugs are parsed out of
 * `tool-pages.ts` — `sitemap.xml` and `robots.txt`.
 *
 * It is a constant rather than something derived from `document.location`
 * because the pages that need it are **prerendered at build time**, where the
 * only location available is Angular's synthetic `http://ng-localhost`. That is
 * exactly what shipped: every canonical, `og:url` and JSON-LD `url` in the
 * served HTML named a host that does not exist, and the sitemap and robots
 * advertised `http://localhost:4200` because the generator's fallback was a
 * developer default nobody set `SITE_URL` over. A crawler rejects a sitemap
 * whose URLs are on another host, so the whole file was inert.
 *
 * When the custom domain lands, change it here and regenerate — `npm run build`
 * does it, and `seo-artifacts.spec.ts` fails if the committed artifacts drift.
 */
export const SITE_URL = 'https://zenpdf.up.railway.app';

/**
 * Point `<link rel="canonical">` and `og:url` at the same absolute URL.
 *
 * One helper because four pages need it and three of them had drifted: the
 * tool pages and the landing page each grew their own copy off
 * `document.location`, and the legal/about pages simply had none.
 */
export function setCanonical(doc: Document, meta: Meta, href: string): void {
  meta.updateTag({ property: 'og:url', content: href });
  let link = doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = doc.createElement('link');
    link.setAttribute('rel', 'canonical');
    doc.head.appendChild(link);
  }
  link.setAttribute('href', href);
}
