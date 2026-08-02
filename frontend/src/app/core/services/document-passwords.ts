import { Injectable, signal } from '@angular/core';

/**
 * The session password for an encrypted document (phase-07, §17).
 *
 * **In memory only.** Not localStorage, not sessionStorage, not a cookie —
 * closing the tab forgets it, which is the behaviour a person protecting a
 * document expects and the only one we can honestly describe in the UI.
 *
 * It lives here, in a service with no dependencies, rather than inside
 * `SecurityFacade`, because *every* operation on an unlocked document needs to
 * carry it — rotating a page is as blocked by encryption as re-encrypting is.
 * `DocumentsService` attaches it centrally, so no feature has to remember to.
 */
@Injectable({ providedIn: 'root' })
export class DocumentPasswords {
  private passwords = new Map<string, string>();
  /** Ids only — the value is never exposed to a template. */
  private _unlocked = signal<string[]>([]);

  readonly unlocked = this._unlocked.asReadonly();

  remember(docId: string, password: string): void {
    if (!password) return;
    this.passwords.set(docId, password);
    this._unlocked.update((ids) => (ids.includes(docId) ? ids : [...ids, docId]));
  }

  forget(docId: string): void {
    this.passwords.delete(docId);
    this._unlocked.update((ids) => ids.filter((id) => id !== docId));
  }

  passwordFor(docId: string): string {
    return this.passwords.get(docId) ?? '';
  }

  isUnlocked(docId: string): boolean {
    return this._unlocked().includes(docId);
  }
}
