import { RenderMode, ServerRoute } from '@angular/ssr';

import { TOOL_SLUGS } from './core/tool-pages';

/**
 * Which routes are server-rendered (01-architecture.md §7, §21.6).
 *
 * The split is deliberate, not incidental. Landing and tool pages are the
 * acquisition channel an ad-funded product depends on, so they prerender and
 * are individually indexable. `/app/**` stays **client-rendered**: the
 * workspace wraps ngx-extended-pdf-viewer, which touches browser-only APIs and
 * is the most likely source of a hydration mismatch — and it has no SEO value
 * anyway. `/s/:token` and `/verify` (phase 8) will stay client-rendered for the
 * same reason plus the ceremony must never be cached.
 */
export const serverRoutes: ServerRoute[] = [
  { path: '', renderMode: RenderMode.Prerender },
  ...TOOL_SLUGS.map(
    (slug): ServerRoute => ({ path: slug, renderMode: RenderMode.Prerender }),
  ),
  { path: 'auth/login', renderMode: RenderMode.Client },
  { path: 'auth/register', renderMode: RenderMode.Client },
  { path: 'app/**', renderMode: RenderMode.Client },
  // Client-rendered, deliberately: the ceremony must never be cached by a CDN
  // (one recipient's page served to another would be a disclosure), and both
  // pages are worthless to a search engine.
  { path: 's/:token', renderMode: RenderMode.Client },
  { path: 'verify', renderMode: RenderMode.Client },
  { path: 'legal/esign-disclosure', renderMode: RenderMode.Prerender },
  // Prerendered: AdSense review reads them, and so do people.
  { path: 'legal/privacy', renderMode: RenderMode.Prerender },
  { path: 'legal/terms', renderMode: RenderMode.Prerender },
  { path: 'about', renderMode: RenderMode.Prerender },
  { path: 'unsubscribe/:token', renderMode: RenderMode.Client },
  { path: 'verify-email/:token', renderMode: RenderMode.Client },
  { path: '**', renderMode: RenderMode.Client },
];
