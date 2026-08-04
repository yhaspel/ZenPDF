import { TestBed } from '@angular/core/testing';

import { DocumentPasswords } from './document-passwords';

/**
 * L7 — a token is not the only credential a session holds.
 *
 * These passwords live in a tab-scoped map, and `DocumentsService` attaches
 * them to outgoing requests by document id without asking who is asking. They
 * survived a sign-out, so on a shared machine the next person to use the tab
 * inherited them.
 */
describe('DocumentPasswords', () => {
  let passwords: DocumentPasswords;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    passwords = TestBed.inject(DocumentPasswords);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('remembers a password for the document it belongs to', () => {
    passwords.remember('doc-1', 'hunter2');
    expect(passwords.passwordFor('doc-1')).toBe('hunter2');
    expect(passwords.isUnlocked('doc-1')).toBe(true);
    expect(passwords.unlocked()).toEqual(['doc-1']);
  });

  it('forgets every password on clearAll', () => {
    passwords.remember('doc-1', 'hunter2');
    passwords.remember('doc-2', 'correct horse');

    passwords.clearAll();

    expect(passwords.passwordFor('doc-1')).toBe('');
    expect(passwords.passwordFor('doc-2')).toBe('');
    expect(passwords.isUnlocked('doc-1')).toBe(false);
    expect(passwords.unlocked()).toEqual([]);
  });

  it('leaves the store usable afterwards', () => {
    passwords.remember('doc-1', 'hunter2');
    passwords.clearAll();
    passwords.remember('doc-3', 'new session');
    expect(passwords.passwordFor('doc-3')).toBe('new session');
    expect(passwords.unlocked()).toEqual(['doc-3']);
  });
});
