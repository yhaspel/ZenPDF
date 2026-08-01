import { TestBed } from '@angular/core/testing';

import { TokenService } from './token.service';

describe('TokenService', () => {
  let tokens: TokenService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    tokens = TestBed.inject(TokenService);
  });

  afterEach(() => localStorage.clear());

  it('seeds from storage and writes through', () => {
    expect(tokens.isAuthenticated).toBe(false);

    tokens.set('access-1', 'refresh-1');
    expect(tokens.access).toBe('access-1');
    expect(tokens.refresh).toBe('refresh-1');
    expect(localStorage.getItem('zen_access')).toBe('access-1');

    tokens.clear();
    expect(tokens.access).toBeNull();
    expect(tokens.refresh).toBeNull();
    expect(localStorage.getItem('zen_refresh')).toBeNull();
  });

  it('picks up a token another tab wrote', () => {
    // Reading localStorage per call used to make this free: a login, a logout
    // or a refresh rotation in one tab was seen by the next request in every
    // other tab. Holding the token in a signal without listening for `storage`
    // would make each tab a private session — and a tab that still believes it
    // is anonymous mints a *guest* session, so a logged-in user's upload would
    // quietly acquire a 24-hour TTL.
    localStorage.setItem('zen_access', 'from-another-tab');
    localStorage.setItem('zen_refresh', 'refresh-from-another-tab');
    window.dispatchEvent(new StorageEvent('storage', { key: 'zen_access' }));

    expect(tokens.access).toBe('from-another-tab');
    expect(tokens.refresh).toBe('refresh-from-another-tab');
  });

  it('picks up a logout in another tab', () => {
    tokens.set('access-1', 'refresh-1');
    localStorage.removeItem('zen_access');
    localStorage.removeItem('zen_refresh');
    window.dispatchEvent(new StorageEvent('storage', { key: 'zen_access' }));

    expect(tokens.isAuthenticated).toBe(false);
    expect(tokens.refresh).toBeNull();
  });

  it('ignores unrelated storage keys', () => {
    tokens.set('access-1', 'refresh-1');
    localStorage.setItem('something-else', 'x');
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    expect(tokens.access).toBe('access-1');
  });

  it('treats a clear() elsewhere (key === null) as a logout', () => {
    tokens.set('access-1', 'refresh-1');
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(tokens.access).toBeNull();
  });
});
