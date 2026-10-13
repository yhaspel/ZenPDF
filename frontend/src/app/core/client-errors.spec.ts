import { HttpErrorResponse } from '@angular/common/http';

import { ClientErrorHandler } from './client-errors';

/**
 * Client-side crash reporting (§10.4).
 *
 * The handler posts four short strings to our own origin and nothing else.
 * What matters most is what it must *not* do: report an HTTP failure twice,
 * loop on a component that throws on every change detection, ship a signing
 * token or an email address in a stack trace, or become the second failure
 * when the report itself cannot be sent.
 */
describe('ClientErrorHandler', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let handler: ClientErrorHandler;

  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.history.replaceState(null, '', '/app/dashboard');
    handler = new ClientErrorHandler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The JSON body of the n-th report. */
  function body(n = 0): { name: string; message: string; stack: string; route: string } {
    const [, init] = fetchSpy.mock.calls[n] as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  it('posts name, message, stack and route to /api/client-errors/ with no credential', () => {
    const err = new TypeError('x is not a function');
    handler.handleError(err);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/client-errors/');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(body()).toEqual({
      name: 'TypeError',
      message: 'x is not a function',
      stack: expect.stringContaining('x is not a function') as string,
      route: '/app/dashboard',
    });
    // The console still gets it: reporting is in addition to, not instead of.
    expect(console.error).toHaveBeenCalledWith(err);
  });

  it('unwraps the error Angular wrapped, and a rejected promise\'s reason', () => {
    handler.handleError({ ngOriginalError: new RangeError('too deep') });
    expect(body(0).name).toBe('RangeError');
    expect(body(0).message).toBe('too deep');

    handler.handleError({ rejection: new Error('chunk 404') });
    expect(body(1).message).toBe('chunk 404');
  });

  it('reports a thrown non-Error as a string with a default name', () => {
    handler.handleError('plain string thrown');
    expect(body()).toMatchObject({ name: 'Error', message: 'plain string thrown', stack: '' });
  });

  it('ignores HTTP failures, which are already answered where they happen', () => {
    handler.handleError(new HttpErrorResponse({ status: 429, statusText: 'Too Many Requests' }));
    handler.handleError({ ngOriginalError: new HttpErrorResponse({ status: 500 }) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores an error with no message, since there is nothing to tell apart', () => {
    handler.handleError(new Error(''));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports the same crash once per page load', () => {
    handler.handleError(new Error('same thing'));
    handler.handleError(new Error('same thing'));
    handler.handleError(new Error('same thing'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A different message is a different crash.
    handler.handleError(new Error('other thing'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('stops after five distinct crashes, so a loop cannot point at our own API', () => {
    for (let i = 0; i < 9; i++) handler.handleError(new Error(`crash ${i}`));
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('redacts signing tokens, email addresses and long tokens from message, stack and route', () => {
    window.history.replaceState(null, '', '/s/ceremony-token-value-12345');
    const err = new Error(
      'failed for sam@example.com at /public/sign/abcdef1234567890/content/'
      + ' with key ' + 'A'.repeat(40),
    );
    err.stack = 'Error: failed at /verify-email/tok-xyz\n    at chunk-ABC.js:1:2\n'
      + '    for pat@example.co.uk';
    handler.handleError(err);

    const sent = body();
    expect(sent.route).toBe('/s/[token]');
    expect(sent.message).toBe('failed for [email] at /public/sign/[token]/content/ with key [token]');
    expect(sent.message).not.toContain('sam@');
    expect(sent.stack).toContain('/verify-email/[token]');
    expect(sent.stack).toContain('[email]');
    expect(sent.stack).not.toContain('pat@');
    expect(sent.stack).toContain('chunk-ABC.js:1:2');
  });

  it('truncates a runaway message and stack', () => {
    // Spaced, so the long-token scrubber does not fold the whole thing.
    const err = new Error('long message '.repeat(100));
    err.stack = 'long stack '.repeat(500);
    handler.handleError(err);
    expect(body().message.length).toBe(300);
    expect(body().stack.length).toBe(2000);
  });

  it('never throws itself when the report cannot be sent', async () => {
    const rejected = Promise.reject(new Error('offline'));
    fetchSpy.mockReturnValueOnce(rejected);
    expect(() => handler.handleError(new Error('first'))).not.toThrow();
    // The rejection is swallowed by the handler's own `.catch`; give it a turn.
    await Promise.resolve();
    await Promise.resolve();

    fetchSpy.mockImplementationOnce(() => {
      throw new TypeError('fetch is broken');
    });
    expect(() => handler.handleError(new Error('second'))).not.toThrow();
  });
});
