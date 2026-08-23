import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { DocumentsFacade } from '../../abstraction/documents.facade';

/**
 * The trashed document that cannot be deleted (queue row 2026-08-02, UI half).
 *
 * `_purge` has always refused a document a signature request points at —
 * `source_version` is `PROTECT`, and the signed record has to keep pointing at
 * what was signed. What the owner saw was "Delete forever", a card that
 * vanished and came back, and no explanation: the facade's error handler was
 * `error: () => this.load()`, which discards the server's sentence entirely.
 *
 * This file covers the facade half — that the refusal is kept and keyed to the
 * document it belongs to. The card half (button absent, notice rendered) is
 * asserted end to end in `e2e/tests/phase-1.spec.ts`, where a real refusal from
 * a real request can be produced.
 */
describe('DocumentsFacade — a refused permanent delete keeps its reason', () => {
  let facade: DocumentsFacade;

  const REFUSAL = 'This document has been sent for signature, so it cannot be '
    + 'deleted — the signed record has to keep pointing at what was signed.';

  function refusalFor(message: string): HttpErrorResponse {
    return new HttpErrorResponse({
      status: 400,
      error: { error: { code: 'validation_error', message, details: {} } },
    });
  }

  beforeEach(() => {
    TestBed.configureTestingModule({});
    facade = TestBed.inject(DocumentsFacade);
  });

  afterEach(() => TestBed.resetTestingModule());

  function purgeWith(id: string, result: 'ok' | HttpErrorResponse): void {
    const svc = (facade as unknown as {
      docsSvc: { purge(id: string): unknown };
      load(): void;
      refreshUsage(): void;
    });
    svc.load = () => undefined;
    svc.refreshUsage = () => undefined;
    svc.docsSvc.purge = () => ({
      subscribe: (handlers: { next?: () => void; error?: (e: unknown) => void }) => {
        if (result === 'ok') handlers.next?.();
        else handlers.error?.(result);
        return { unsubscribe: () => undefined };
      },
    });
    facade.purge(id);
  }

  it('starts with nothing to explain', () => {
    expect(facade.purgeErrors()).toEqual({});
  });

  it("keeps the server's own sentence, keyed to the document", () => {
    purgeWith('doc-1', refusalFor(REFUSAL));

    expect(facade.purgeErrors()['doc-1']).toBe(REFUSAL);
    expect(facade.purgeErrors()['doc-2']).toBeUndefined();
  });

  it('falls back to a plain sentence rather than a status code', () => {
    purgeWith('doc-1', new HttpErrorResponse({ status: 503 }));

    const shown = facade.purgeErrors()['doc-1'];
    expect(shown).toContain('could not be deleted');
    expect(shown).not.toContain('503');
  });

  it('records nothing when the delete succeeds', () => {
    purgeWith('doc-1', 'ok');
    expect(facade.purgeErrors()['doc-1']).toBeUndefined();
  });

  it('clears a stale refusal when the same document is retried', () => {
    purgeWith('doc-1', refusalFor(REFUSAL));
    expect(facade.purgeErrors()['doc-1']).toBe(REFUSAL);

    // The request was cancelled, so the second attempt is allowed through.
    purgeWith('doc-1', 'ok');
    expect(facade.purgeErrors()['doc-1']).toBeUndefined();
  });

  it('forgets a refusal on request', () => {
    purgeWith('doc-1', refusalFor(REFUSAL));
    facade.clearPurgeError('doc-1');
    expect(facade.purgeErrors()['doc-1']).toBeUndefined();
  });

  it('keeps two documents\' refusals apart', () => {
    purgeWith('doc-1', refusalFor(REFUSAL));
    purgeWith('doc-2', refusalFor('Something else entirely.'));

    expect(facade.purgeErrors()['doc-1']).toBe(REFUSAL);
    expect(facade.purgeErrors()['doc-2']).toBe('Something else entirely.');
  });
});
