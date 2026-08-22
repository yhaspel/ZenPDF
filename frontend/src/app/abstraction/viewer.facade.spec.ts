import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of, throwError } from 'rxjs';

import { DocumentModel, Job } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { ViewerFacade } from './viewer.facade';

/**
 * M7 — the workspace's failure states.
 *
 * `load()` subscribed with no error handler and the facade had no `loading` or
 * `error` signal, so a stale `/app/doc/:id`, a document belonging to somebody
 * else, a 500 or an offline browser all produced the same thing: `doc()` stays
 * null, the template gates on it with no `@else`, and the person is looking at
 * a white screen with no message and no way out.
 */
describe('ViewerFacade failure states', () => {
  function facadeWith(get: () => Observable<DocumentModel>): ViewerFacade {
    const fake: Partial<DocumentsService> = {
      get,
      versions: () => of({ count: 0, next: null, previous: null, results: [] }) as never,
      outline: () => of({ outline: [] }) as never,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: DocumentsService, useValue: fake }],
    });
    return TestBed.inject(ViewerFacade);
  }

  function httpError(status: number, body?: unknown): HttpErrorResponse {
    return new HttpErrorResponse({ status, error: body });
  }

  afterEach(() => TestBed.resetTestingModule());

  it('reports the server’s own sentence when it sent one', () => {
    const facade = facadeWith(() =>
      throwError(() =>
        httpError(410, {
          error: { code: 'guest_expired', message: 'Your guest session ended.', details: {} },
        }),
      ),
    );

    facade.load('doc-1');

    expect(facade.doc()).toBeNull();
    expect(facade.loading()).toBe(false);
    expect(facade.error()).toEqual({
      code: 'guest_expired',
      message: 'Your guest session ended.',
    });
  });

  it('has a sentence of its own for a 404 with no envelope', () => {
    const facade = facadeWith(() => throwError(() => httpError(404)));
    facade.load('gone');
    expect(facade.error()?.code).toBe('not_found');
    expect(facade.error()?.message).toContain('could not be found');
  });

  it('says something useful when the browser never reached us', () => {
    const facade = facadeWith(() => throwError(() => httpError(0)));
    facade.load('doc-1');
    expect(facade.error()?.code).toBe('offline');
    expect(facade.error()?.message).toContain('connection');
  });

  it('never leaves the failure with neither a document nor a message', () => {
    const facade = facadeWith(() => throwError(() => httpError(500)));
    facade.load('doc-1');
    expect(facade.doc()).toBeNull();
    expect(facade.error()?.message).toBeTruthy();
  });

  it('clears the previous document rather than showing it under an error', () => {
    let fail = false;
    const facade = facadeWith(
      () => (fail ? throwError(() => httpError(500)) : of({ id: 'd1', title: 'A' } as DocumentModel)),
    );

    facade.load('d1');
    expect(facade.doc()).not.toBeNull();

    fail = true;
    facade.load('d1');
    expect(facade.doc()).toBeNull();
    expect(facade.error()).not.toBeNull();
  });

  it('clears a stale error when a later load succeeds', () => {
    let fail = true;
    const facade = facadeWith(
      () => (fail ? throwError(() => httpError(500)) : of({ id: 'd1', title: 'A' } as DocumentModel)),
    );

    facade.load('d1');
    expect(facade.error()).not.toBeNull();

    fail = false;
    facade.load('d1');
    expect(facade.error()).toBeNull();
    expect(facade.doc()).not.toBeNull();
    expect(facade.loading()).toBe(false);
  });
});

/**
 * `adopt()` — the `version_conflict` race, fixed where it happens.
 *
 * Measured on `main`: 2 of 6 runs of `phase-3`/`phase-4` red, in isolation, on
 * a settled stack. A save succeeds, the workspace calls `reload()`, and the
 * refetch is asynchronous — so until that GET lands `currentSeq()` is a version
 * behind and anything dispatched meanwhile carries a stale `base_version_seq`
 * straight into a refusal. Every failed job across a full suite run was that
 * one code.
 *
 * The whole fix is that the job already knows the answer. These tests pin what
 * makes taking it safe: the seq lands before the refetch, nothing is invented
 * when the job reports nothing, and the generation guard still wins.
 */
describe('ViewerFacade.adopt', () => {
  const DOC: DocumentModel = {
    id: 'd1',
    title: 'A file',
    page_count: 3,
    current_version: { id: 'v1', seq: 1, label: 'Uploaded' },
  } as DocumentModel;

  function facadeWith(get: () => Observable<DocumentModel>): ViewerFacade {
    const fake: Partial<DocumentsService> = {
      get,
      versions: () => of({ count: 0, next: null, previous: null, results: [] }) as never,
      outline: () => of({ outline: [] }) as never,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: DocumentsService, useValue: fake }],
    });
    return TestBed.inject(ViewerFacade);
  }

  function succeeded(result: Record<string, unknown> | null): Job {
    return { id: 'j1', status: 'succeeded', result } as unknown as Job;
  }

  /**
   * A facade that has loaded the document once, and whose next refetch is
   * deliberately stuck.
   *
   * That stuck GET **is** the race window. A fake that answers synchronously
   * would let `reload()`'s own answer overwrite whatever `adopt()` set, one
   * microtask later, and every assertion below would be about the fake instead
   * of about the fix.
   */
  function loadedFacade(): ViewerFacade {
    const pending = new Subject<DocumentModel>();
    let calls = 0;
    const facade = facadeWith(() => (calls++ === 0 ? of(DOC) : pending));
    facade.load('d1');
    return facade;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('has the new seq before the refetch has answered — the whole point', () => {
    const facade = loadedFacade();
    expect(facade.currentSeq()).toBe(1);

    facade.adopt(succeeded({ document_id: 'd1', version_id: 'v2', seq: 2 }));

    expect(facade.currentSeq()).toBe(2);
    expect(facade.doc()?.id).toBe('d1');
  });

  it('takes a page count too when the job reports one', () => {
    const facade = loadedFacade();
    facade.adopt(succeeded({ seq: 2, page_count: 5 }));
    expect(facade.pageCount()).toBe(5);
  });

  it('leaves the page count alone when the job does not report one', () => {
    // No task emits `page_count` today; the reload behind this corrects it.
    // What must not happen is a *guess* — a page count invented here would be
    // the same defect as the stale seq, with the blame reversed.
    const facade = loadedFacade();
    facade.adopt(succeeded({ seq: 2 }));
    expect(facade.pageCount()).toBe(3);
  });

  it('falls back to a plain reload for a result with no seq', () => {
    // Find-and-replace dry runs and exports produce no version at all.
    let calls = 0;
    const facade = facadeWith(() => {
      calls += 1;
      return of(DOC);
    });

    facade.load('d1');
    expect(calls).toBe(1);

    facade.adopt(succeeded({ report: { matches: 0 } }));
    expect(facade.currentSeq()).toBe(1);
    expect(calls).toBe(2);
  });

  it('falls back to a plain reload for a job with no result at all', () => {
    const facade = facadeWith(() => of(DOC));
    facade.load('d1');
    facade.adopt(succeeded(null));
    expect(facade.currentSeq()).toBe(1);
  });

  it('does nothing at all when there is no document to advance', () => {
    let calls = 0;
    const facade = facadeWith(() => {
      calls += 1;
      return of(DOC);
    });
    facade.adopt(succeeded({ seq: 2 }));
    expect(facade.doc()).toBeNull();
    expect(calls).toBe(0);
  });

  it('keeps the generation guard: a late answer for a document we left is dropped', () => {
    // Split and extract navigate straight to another document, so two loads
    // can be in flight. `adopt` starts one of them, and its own refetch must
    // still lose to whatever came after it.
    const slow = new Subject<DocumentModel>();
    let calls = 0;
    const facade = facadeWith(() => {
      calls += 1;
      if (calls === 1) return of(DOC);
      if (calls === 2) return slow; // adopt()'s refetch — deliberately stuck
      return of({ ...DOC, id: 'd2', title: 'Another' } as DocumentModel);
    });

    facade.load('d1');
    facade.adopt(succeeded({ seq: 2 }));
    facade.load('d2');
    expect(facade.doc()?.id).toBe('d2');

    // The abandoned refetch finally answers, with the old document.
    slow.next({ ...DOC, title: 'Stale' } as DocumentModel);
    expect(facade.doc()?.id).toBe('d2');
    expect(facade.doc()?.title).toBe('Another');
  });
});
