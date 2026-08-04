import { DEFAULT_NEXT, safeNext } from './safe-next';

/**
 * L11 — the open redirect behind the signup form.
 *
 * The account gate puts the URL you were heading for in `?next=`, and Register
 * handed it straight to `navigateByUrl`. `//evil.example.com` is a
 * protocol-relative URL, which the router treats as another origin — so the
 * page after "create account" was somebody else's, seconds after the person
 * typed a password into ours.
 */
describe('safeNext', () => {
  it('keeps an ordinary same-origin path', () => {
    expect(safeNext('/app/sign/new/abc')).toBe('/app/sign/new/abc');
    expect(safeNext('/app/doc/1?mode=annotate')).toBe('/app/doc/1?mode=annotate');
  });

  it('refuses a protocol-relative URL', () => {
    expect(safeNext('//evil.example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('//evil.example.com/app/dashboard')).toBe(DEFAULT_NEXT);
  });

  it('refuses a backslash, which some parsers fold to a slash', () => {
    expect(safeNext('/\\evil.example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('/app\\..\\evil')).toBe(DEFAULT_NEXT);
  });

  it('refuses anything carrying a scheme or a host', () => {
    expect(safeNext('https://evil.example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('javascript:alert(1)')).toBe(DEFAULT_NEXT);
    expect(safeNext('evil.example.com/app')).toBe(DEFAULT_NEXT);
  });

  it('refuses control characters a browser would strip before parsing', () => {
    // `/\t/evil.example.com` becomes `//evil.example.com` once the tab is gone.
    expect(safeNext('/\t/evil.example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\n//evil.example.com')).toBe(DEFAULT_NEXT);
  });

  it('falls back to the dashboard when there is nothing to go on', () => {
    expect(safeNext(null)).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext('')).toBe(DEFAULT_NEXT);
    expect(safeNext('   ')).toBe(DEFAULT_NEXT);
  });
});
