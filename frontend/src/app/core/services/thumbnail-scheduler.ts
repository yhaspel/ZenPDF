import { HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';

/** The statuses worth asking again about. Everything else is an answer. */
const RETRYABLE = new Set([429, 503]);

/** Attempts in total, the first one included. */
export const MAX_ATTEMPTS = 4;

/** First backoff, doubling per attempt. */
const BASE_MS = 1_000;

/** The ceiling, however long `Retry-After` says or the doubling reaches. */
const MAX_MS = 30_000;

/** Spread, so a paused rail does not resume on one millisecond. */
const JITTER_MS = 400;

/**
 * One rail, one throttle, one place that knows about it.
 *
 * A 500-page document mounts 500 tiles and the guest throttle is 40 requests a
 * minute. Left to themselves each tile discovers the limit separately, so the
 * rail spends its whole budget being refused: the retry that shipped for L9
 * turned that into 500 buttons a person could mash, which is not a backoff.
 *
 * So the refusal is shared. The first tile to be told "429" writes down when
 * anybody may ask again, and every other tile reads that before it fetches —
 * one tile discovers the limit and the rail as a whole waits it out. Held as a
 * plain timestamp rather than a queue: there is nothing to schedule, only
 * something to not do yet, and a queue would need draining, cancelling and
 * reordering as tiles scroll out of view.
 *
 * Root-provided, so the workspace rail and the Organize grid — which mount a
 * full set of tiles each, over the same document, against the same throttle —
 * are one rail as far as the server is concerned, which is what they are.
 */
@Injectable({ providedIn: 'root' })
export class ThumbnailScheduler {
  /** Epoch ms before which no tile asks. */
  private pausedUntil = 0;

  /** True while the rail is waiting a refusal out. */
  get paused(): boolean {
    return this.pausedUntil > Date.now();
  }

  /**
   * How long this tile must wait before it may ask, in ms.
   *
   * **Zero on a healthy rail** — deliberately, and the call site skips the
   * timer entirely for zero, so nothing about this makes an unthrottled
   * document slower than it was. The jitter is added only to a real wait,
   * where the alternative is the whole rail firing again on the same
   * millisecond the window opens, which is how one 429 becomes the next.
   */
  holdFor(): number {
    const remaining = this.pausedUntil - Date.now();
    if (remaining <= 0) return 0;
    return remaining + Math.floor(Math.random() * JITTER_MS);
  }

  /** Whether asking again could possibly help. */
  worthRetrying(error: unknown, attempt: number): boolean {
    return attempt < MAX_ATTEMPTS && RETRYABLE.has(statusOf(error));
  }

  /**
   * Record a refusal and answer with how long to wait before asking again.
   *
   * `Retry-After` wins where the server sent one — it knows when the window
   * turns over and the doubling is only a guess at it. Numeric seconds only:
   * that is what DRF's throttling sends, and an HTTP-date would be a parser
   * for a case this API does not produce.
   */
  refused(error: unknown, attempt: number): number {
    const retryAfter = retryAfterMs(error);
    const wait = Math.min(MAX_MS, retryAfter ?? BASE_MS * 2 ** (attempt - 1));
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + wait);
    return wait + Math.floor(Math.random() * JITTER_MS);
  }

  /** For tests and for a fresh document; the rail carries no other state. */
  reset(): void {
    this.pausedUntil = 0;
  }
}

function statusOf(error: unknown): number {
  return (error as { status?: number } | null)?.status ?? 0;
}

function retryAfterMs(error: unknown): number | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const seconds = Number(error.headers?.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}
