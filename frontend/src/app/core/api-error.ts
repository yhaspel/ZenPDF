import { HttpErrorResponse } from '@angular/common/http';

/**
 * The §6 error envelope, read off an HTTP failure without trusting its shape.
 *
 * Every non-2xx from this API is `{"error": {"code", "message", "details"}}`
 * (01-architecture.md §6). What `HttpErrorResponse.error` actually holds is
 * `any`, so until 2026-08-24 twenty-eight call sites spelled the same walk
 * down that envelope by hand — `err.error?.error?.message` — and the compiler
 * checked none of them. Four spellings of the same walk had accumulated: two
 * different inline casts (`{ error?: { error?: { message?: string } } }` and
 * the same shape with `code`), a cast to `HttpErrorResponse`, and one function
 * whose parameter was *declared* as the envelope shape and handed an
 * `HttpErrorResponse` at all six of its call sites — which type-checked, since
 * `any` satisfies anything.
 *
 * **Every field here is optional on purpose, and `message` is verbatim.** The
 * call sites carry their own fallback copy, written for the screen it appears
 * on, and they are split between `??` and `||` — which disagree exactly when
 * the server sends an empty string. Returning `''` as `''` (rather than
 * normalising it to `undefined`, or to a fallback sentence of our own) is what
 * lets every one of those sites keep its operator and its copy and mean what
 * it meant before.
 */
export interface ApiError {
  /** `error.code` — a §6 machine code. Absent when the body carried none. */
  code?: string;
  /** `error.message` — the server's own sentence, exactly as it sent it. */
  message?: string;
  /** `error.details` — per-code extras; `{}` and absent are different. */
  details?: Record<string, unknown>;
  /**
   * The HTTP status, or **0** for a request that never reached the server —
   * offline, DNS, CORS, or a cancelled request. Angular reports all of those
   * as `status: 0`, and so does this.
   */
  status: number;
  /**
   * Whole seconds to wait, for the one failure here that is not a failure.
   * Present only when the server asked, and only when it asked for a positive
   * number of seconds.
   */
  retryAfter?: number;
}

/** A plain object, or undefined for anything else — `null`, an array, a
 *  `Blob` from a `responseType: 'blob'` download, a string from a non-JSON
 *  body, an `Error` that never went near HTTP. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whole seconds, from the envelope first and the header second.
 *
 * `details.retry_after_seconds` is what `apps/core/exceptions.py` puts there
 * for anything carrying a `wait`; DRF sets the `Retry-After` header alongside
 * it. The envelope wins because it is the value this API chose to publish —
 * the header is the fallback for a 429 or 503 that never reached Django at
 * all, from nginx or a proxy, where there is no envelope to read.
 *
 * Numeric seconds only. An HTTP-date is legal in the header and this API does
 * not produce one — the same call `thumbnail-scheduler.ts` made, for the same
 * reason: a parser for a case that cannot arrive is a branch no test can
 * honestly cover.
 */
function retryAfterSeconds(
  details: Record<string, unknown> | undefined,
  response: HttpErrorResponse | undefined,
): number | undefined {
  const fromEnvelope = Number(details?.['retry_after_seconds']);
  const fromHeader = Number(response?.headers?.get('Retry-After'));
  const seconds = Number.isFinite(fromEnvelope) && fromEnvelope > 0
    ? fromEnvelope
    : fromHeader;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/**
 * Narrow any thrown thing into the §6 envelope.
 *
 * Total by design — it never throws and never returns null, because it is
 * called from `error:` callbacks where a second failure has nowhere to go.
 * Anything that does not carry a JSON object body shaped like the envelope
 * comes back as `{ status: 0 }` with no envelope, which is the truth: nothing
 * explained itself.
 */
export function apiError(err: unknown): ApiError {
  // **Structural, not `instanceof HttpErrorResponse`** — and that is load
  // bearing. Every spelling this replaced walked the shape rather than
  // checking the class, so several suites throw a plain
  // `{ status, error: { error: {…} } }` literal and were entitled to. Adding
  // an `instanceof` gate here narrowed three workspace error screens down to
  // "We could not reach ZenPDF" on the way through, which is the exact defect
  // this change exists not to introduce: an error that stops showing the
  // sentence the server sent. The class is used below only for the one thing
  // a literal cannot carry — a response header.
  const failure = asRecord(err);
  // `.error` is the parsed body when the body was JSON, and otherwise a
  // string, a `Blob`, a `ProgressEvent` or null. Only the first is an
  // envelope; the rest fall through to a bare status.
  const envelope = asRecord(asRecord(failure?.['error'])?.['error']);

  const code = asString(envelope?.['code']);
  const message = asString(envelope?.['message']);
  const details = asRecord(envelope?.['details']);
  const status = failure?.['status'];
  const retryAfter = retryAfterSeconds(
    details,
    err instanceof HttpErrorResponse ? err : undefined,
  );

  return {
    ...(code !== undefined && { code }),
    ...(message !== undefined && { message }),
    ...(details !== undefined && { details }),
    status: typeof status === 'number' ? status : 0,
    ...(retryAfter !== undefined && { retryAfter }),
  };
}

/**
 * Did the server explain itself?
 *
 * The distinction every error screen draws is "show the server's sentence"
 * against "show ours" — and a 502 from nginx, an offline browser and a failed
 * blob download all arrive with no envelope at all, so there is nothing of
 * theirs to show.
 */
export function isApiError(err: unknown): boolean {
  const { code, message } = apiError(err);
  return code !== undefined || message !== undefined;
}
