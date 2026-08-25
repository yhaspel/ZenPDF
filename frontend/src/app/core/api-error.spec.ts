import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';

import { ApiError, apiError } from './api-error';

/**
 * The typed read of the §6 error envelope.
 *
 * Twenty-eight call sites used to walk `err.error?.error?.message` by hand
 * through an `any`, so nothing here was checked by anything. The cases that
 * matter are the ones where the body is *not* the envelope — a blob download,
 * a proxy's HTML, an offline browser — because those are the paths that put a
 * fallback sentence on the screen, and the fallback belongs to the call site.
 */

function httpError(init: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): HttpErrorResponse {
  return new HttpErrorResponse({
    status: init.status ?? 400,
    error: init.body,
    ...(init.headers ? { headers: new HttpHeaders(init.headers) } : {}),
  });
}

function envelope(
  error: Record<string, unknown>,
  status = 400,
  headers?: Record<string, string>,
): HttpErrorResponse {
  return httpError({ status, body: { error }, headers });
}

describe('apiError', () => {
  it('reads a §6 envelope whole', () => {
    const result = apiError(
      envelope(
        {
          code: 'unsupported_file',
          message: 'That file is not a PDF.',
          details: { received: 'image/png' },
        },
        415,
      ),
    );

    expect(result).toEqual<ApiError>({
      code: 'unsupported_file',
      message: 'That file is not a PDF.',
      details: { received: 'image/png' },
      status: 415,
    });
  });

  it('omits what the envelope did not carry, rather than inventing it', () => {
    // `code` alone is a real response — `_extract_code` always sets one, and
    // `details` is frequently `{}` and dropped by DRF before it is sent.
    expect(apiError(envelope({ code: 'not_found' }, 404))).toEqual<ApiError>({
      code: 'not_found',
      status: 404,
    });
  });

  it('keeps an empty message as an empty message', () => {
    // The whole reason `message` is `string | undefined` and not a sentence of
    // our own. The call sites are split between `??` and `||`, and those two
    // disagree on exactly this value: `'' ?? f` is `''`, `'' || f` is `f`.
    // Normalising here would silently pick a side at all twenty-eight of them.
    const result = apiError(envelope({ code: 'validation_error', message: '' }));

    expect(result.message).toBe('');
    expect(result.message ?? 'fallback').toBe('');
    expect(result.message || 'fallback').toBe('fallback');
  });

  it('ignores a body that is not the envelope', () => {
    // nginx's own 502 page, and anything else that never reached Django.
    const result = apiError(httpError({ status: 502, body: '<html>502</html>' }));

    expect(result).toEqual<ApiError>({ status: 502 });
  });

  it('ignores a blob body, which is what a failed download returns', () => {
    // `responseType: 'blob'` means Angular does not parse the body at all, so
    // `.error` is a `Blob` and the envelope inside it is unreachable without
    // an async read. The download call sites show their own copy and this
    // must not throw on the way there.
    const result = apiError(
      httpError({ status: 410, body: new Blob(['{"error":{}}'], { type: 'application/json' }) }),
    );

    expect(result).toEqual<ApiError>({ status: 410 });
  });

  it('reports a request that never reached the server as status 0', () => {
    // Offline, DNS, CORS or cancelled. Angular reports all four this way and
    // hands back a `ProgressEvent` as the body.
    const result = apiError(
      new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }),
    );

    expect(result).toEqual<ApiError>({ status: 0 });
  });

  it('is total: anything unenvelope-shaped is a bare status 0', () => {
    // It is called from `error:` callbacks, where throwing has nowhere to go.
    for (const thrown of [null, undefined, 'boom', 42, new Error('boom'), {}, []]) {
      expect(apiError(thrown)).toEqual<ApiError>({ status: 0 });
    }
  });

  it('reads a plain object shaped like a failure, not only an HttpErrorResponse', () => {
    // **Regression pin.** The first cut of this helper gated on `instanceof
    // HttpErrorResponse`, which is what a real `HttpClient` always throws —
    // but every spelling it replaced walked the shape instead, so suites
    // throw literals of this shape and were entitled to. The gate turned
    // three workspace error screens into "We could not reach ZenPDF": a
    // narrowed error that stopped showing the sentence the server sent.
    const result = apiError({
      status: 410,
      error: { error: { code: 'guest_expired', message: 'Your guest session ended.', details: {} } },
    });

    expect(result).toEqual<ApiError>({
      code: 'guest_expired',
      message: 'Your guest session ended.',
      details: {},
      status: 410,
    });
  });

  it('ignores a status that is not a number', () => {
    expect(apiError({ status: '404' }).status).toBe(0);
  });

  it('refuses a null and an array body without walking into them', () => {
    expect(apiError(httpError({ body: null }))).toEqual<ApiError>({ status: 400 });
    expect(apiError(httpError({ body: [{ error: { code: 'x' } }] }))).toEqual<ApiError>({
      status: 400,
    });
    // A body that *is* an object but whose `error` is a string, not an object.
    expect(apiError(httpError({ body: { error: 'nope' } }))).toEqual<ApiError>({ status: 400 });
  });

  it('drops a code or message that is not a string', () => {
    // §6 pins both to strings. A number would previously have been rendered
    // through a template; the call site's own sentence is the better answer.
    const result = apiError(envelope({ code: 7, message: { nested: true }, details: 'no' }));

    expect(result).toEqual<ApiError>({ status: 400 });
  });

  describe('retryAfter', () => {
    it('takes whole seconds from the envelope', () => {
      const result = apiError(
        envelope(
          { code: 'throttled', message: 'Slow down.', details: { retry_after_seconds: 42 } },
          429,
        ),
      );

      expect(result.retryAfter).toBe(42);
    });

    it('rounds a fractional wait up, never down', () => {
      // Waiting 30 s when the server said 30.2 asks again inside the window
      // and earns a second 429.
      const result = apiError(
        envelope({ code: 'throttled', details: { retry_after_seconds: 30.2 } }, 429),
      );

      expect(result.retryAfter).toBe(31);
    });

    it('falls back to the Retry-After header when there is no envelope', () => {
      // A 429 from nginx or a proxy: a header, and no §6 body at all.
      const result = apiError(httpError({ status: 429, headers: { 'Retry-After': '15' } }));

      expect(result).toEqual<ApiError>({ status: 429, retryAfter: 15 });
    });

    it('prefers the envelope over the header when both are present', () => {
      // DRF sends both. The envelope is the value this API chose to publish.
      const result = apiError(
        envelope({ code: 'throttled', details: { retry_after_seconds: 42 } }, 429, {
          'Retry-After': '15',
        }),
      );

      expect(result.retryAfter).toBe(42);
    });

    it('ignores a header this API does not produce', () => {
      // An HTTP-date is legal and unparsed here on purpose — the same call
      // `thumbnail-scheduler.ts` made. `Number('Wed, 21 Oct 2026 07:28:00
      // GMT')` is NaN, and NaN must not become a countdown.
      for (const value of ['Wed, 21 Oct 2026 07:28:00 GMT', 'soon', '', '-5', '0']) {
        expect(apiError(httpError({ status: 429, headers: { 'Retry-After': value } })).retryAfter)
          .toBeUndefined();
      }
    });

    it('is absent when nobody asked for a wait', () => {
      expect(apiError(envelope({ code: 'not_found' }, 404)).retryAfter).toBeUndefined();
      expect(apiError(envelope({ code: 'throttled', details: {} }, 429)).retryAfter)
        .toBeUndefined();
    });
  });
});
