import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';

import { DocumentModel } from '../core/models/models';
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
