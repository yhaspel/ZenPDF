/** Where the auth pages are allowed to send you afterwards (L11). */
export const DEFAULT_NEXT = '/app/dashboard';

/**
 * Sanitize a `?next=` before it reaches `navigateByUrl`.
 *
 * The account gate puts the URL you were heading for in the query string and
 * the register page navigates to it verbatim once you sign up. That is an open
 * redirect with a signup form in front of it: `?next=//evil.example.com` is a
 * *protocol-relative* URL, which the router happily treats as another origin,
 * and it lands the person on somebody else's page seconds after they typed a
 * password into ours.
 *
 * Only a same-origin absolute path is allowed through. Anything else — another
 * origin, a scheme, a backslash (which some parsers fold to `/`), a control
 * character, or nothing at all — becomes the dashboard, which is where they
 * were going to end up anyway.
 */
export function safeNext(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_NEXT;
  // Must be a path on this origin.
  if (!value.startsWith('/')) return DEFAULT_NEXT;
  // `//host` and `/\host` are both "somewhere else" to a browser.
  if (value.startsWith('//') || value.startsWith('/\\')) return DEFAULT_NEXT;
  // A backslash anywhere is a parser disagreement waiting to be exploited, and
  // no route in this app contains one.
  if (value.includes('\\')) return DEFAULT_NEXT;
  // Control characters — including the tab and newline a browser strips
  // before parsing, which is how `/<tab>/evil.example.com` becomes
  // `//evil.example.com`.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return DEFAULT_NEXT;
  return value;
}
