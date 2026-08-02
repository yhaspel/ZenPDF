import { HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, Injectable } from '@angular/core';

import { environment } from '../../environments/environment';

/**
 * Client-side crash reporting, to our own origin (§10.4).
 *
 * §10.4 names Angular alongside the api and the workers, and today a
 * client-side exception reaches nobody — verified, not assumed. What it does
 * *not* have to mean is a browser SDK: that would put a third party's code on
 * the signing ceremony, need a source-map upload to make its stack traces
 * readable, and add a processor the privacy policy does not name. This posts
 * four short strings to an endpoint we already own, and they land in the same
 * logger as everything else — so with `SENTRY_DSN` set they become Sentry
 * issues through the server's own scrubber, and without one they are still a
 * line in `logs.sh`.
 */
const TOKEN_PATH = /(\/(?:public\/sign|mail\/unsubscribe|verify-email|s)\/)[^/?#\s]+/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

/** The shapes `apps/core/observability.py` strips server-side, applied here
 *  too — a report is built in the browser, so it is scrubbed in the browser. */
function redact(value: string): string {
  return value
    .replace(TOKEN_PATH, '$1[token]')
    .replace(EMAIL, '[email]')
    .replace(LONG_TOKEN, '[token]');
}

function unwrap(error: unknown): unknown {
  const e = error as { ngOriginalError?: unknown; rejection?: unknown };
  return e?.ngOriginalError ?? e?.rejection ?? error;
}

/** How many distinct crashes one page load may report. A component that throws
 *  on every change detection would otherwise point a loop at our own API. */
const MAX_PER_LOAD = 5;

@Injectable()
export class ClientErrorHandler implements ErrorHandler {
  private readonly seen = new Set<string>();

  handleError(error: unknown): void {
    console.error(error);
    if (typeof location === 'undefined') return; // prerender

    const err = unwrap(error);
    // HTTP failures are already answered where they happen — the interceptor
    // and every facade — so reporting them here turns one 429 into two.
    if (err instanceof HttpErrorResponse) return;

    const name = (err as Error)?.name || 'Error';
    const message = redact(String((err as Error)?.message ?? err)).slice(0, 300);
    const key = `${name}:${message}`;
    if (!message || this.seen.has(key) || this.seen.size >= MAX_PER_LOAD) return;
    this.seen.add(key);

    // Raw fetch, not HttpClient: the interceptor would attach this browser's
    // credential to a report that needs none — and the thing that broke may be
    // the interceptor. `keepalive` so a crash during unload still arrives.
    try {
      void fetch(`${environment.apiUrl}/client-errors/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        keepalive: true,
        body: JSON.stringify({
          name,
          message,
          // The production build ships no source maps, so this is a chunk name
          // and an offset: enough to tell two crashes apart, and it cannot
          // hold a document.
          stack: redact(String((err as Error)?.stack ?? '')).slice(0, 2000),
          route: redact(location.pathname),
        }),
      }).catch(() => undefined);
    } catch {
      // Reporting a failure must never be the second failure.
    }
  }
}
