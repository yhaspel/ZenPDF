import { Injectable, computed, signal } from '@angular/core';

/**
 * What kind of thing is on the editor's clipboard.
 *
 * Typed on purpose: a form field and a redaction area are both a rectangle on
 * a page, and pasting one into the other's layer would produce a shape the
 * receiving feature cannot describe. `read` refuses a mismatch rather than
 * handing back something that only looks right.
 */
export type ClipboardKind = 'annotation' | 'form-field' | 'redaction' | 'placement';

interface Clip {
  kind: ClipboardKind;
  payload: unknown;
}

/**
 * The editor's own clipboard (phase-12 D1).
 *
 * Deliberately **not** the system clipboard. `navigator.clipboard` is async and
 * permission-gated, absent on insecure origins and in jsdom, and what is being
 * copied here is a structured object, not text — serialising an annotation to
 * the OS clipboard would either lose it or pollute what the user actually had
 * copied. ⌘C is skipped entirely when a document text selection is live (see
 * `resolveShortcut`), so copying a comment out of the sidebar still reaches the
 * real clipboard and this never intercepts it.
 *
 * Reading does not consume: paste repeats, the way it does everywhere else.
 */
@Injectable({ providedIn: 'root' })
export class EditorClipboard {
  private readonly _clip = signal<Clip | null>(null);

  /** What kind of thing is held, if any — for enabling menus and buttons. */
  readonly kind = computed<ClipboardKind | null>(() => this._clip()?.kind ?? null);

  copy(kind: ClipboardKind, payload: unknown): void {
    this._clip.set({ kind, payload });
  }

  /** The payload, but only if it is the kind the caller can use. */
  read<T>(kind: ClipboardKind): T | undefined {
    const clip = this._clip();
    if (clip?.kind !== kind) return undefined;
    return clip.payload as T;
  }

  has(kind: ClipboardKind): boolean {
    return this._clip()?.kind === kind;
  }

  clear(): void {
    this._clip.set(null);
  }
}
