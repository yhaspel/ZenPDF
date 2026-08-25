import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';

import { DocumentModel, DocumentVersion } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { ViewerFacade } from './viewer.facade';

/**
 * What the version panel holds when the version request is the thing that fails.
 *
 * `loadVersions` subscribed with a `next` and no `error`, while `loadOutline`
 * three lines below it has always had both. Found by the browser pass for
 * `chore/type-aware-eslint` (PR #38), which noticed an `HttpErrorResponse` in
 * the console of a 404 workspace that was otherwise explaining itself perfectly.
 *
 * The console noise was the symptom. The defect underneath is that a failure
 * here left the **previous** document's versions on screen, each with a "Revert
 * to this" button pointing at a version id belonging to a file the person has
 * navigated away from.
 *
 * ⚠ **Only the first case below discriminates**, and it was checked by running
 * all three against the unfixed facade: that one goes red, the other two stay
 * green. They are guards on deliberate choices rather than proof of the fix —
 * the generation check, and `loadMoreVersions` handling its error by doing
 * nothing on purpose. Both would pass on code that has no error handler at all,
 * which is exactly what they looked like before this change, so neither should
 * ever be read as evidence that the handler is there.
 */
describe('ViewerFacade — versions that fail to load', () => {
  const DOC = {
    id: 'doc-2',
    title: 'Second',
    page_count: 1,
    current_version: { id: 'v1', seq: 1, label: 'Original' },
  } as DocumentModel;

  function version(seq: number): DocumentVersion {
    return { id: `v${seq}`, seq, label: 'Original', size_bytes: 1024 } as DocumentVersion;
  }

  function page(results: DocumentVersion[], count = results.length) {
    return of({ count, next: null, previous: null, results }) as never;
  }

  function facadeWith(overrides: Partial<DocumentsService>): ViewerFacade {
    const fake: Partial<DocumentsService> = {
      get: () => of(DOC),
      versions: () => page([]),
      outline: () => of({ outline: [] }) as never,
      ...overrides,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: DocumentsService, useValue: fake }],
    });
    return TestBed.inject(ViewerFacade);
  }

  afterEach(() => TestBed.resetTestingModule());

  it('empties the panel rather than leaving another document’s versions in it', () => {
    let call = 0;
    const facade = facadeWith({
      // First document's versions arrive; the second document's request fails.
      versions: () => (++call === 1
        ? page([version(1), version(2)], 5)
        : throwError(() => new HttpErrorResponse({ status: 500 }))) as never,
    });

    facade.load('doc-1');
    expect(facade.versions().length).toBe(2);
    expect(facade.versionCount()).toBe(5);

    facade.load('doc-2');

    expect(facade.versions()).toEqual([]);
    // Both, not just the list. The panel renders "Showing the N most recent of
    // M" whenever `versionCount` exceeds what it holds, so clearing one of the
    // two would swap a stale list for the sentence "Showing the 0 most recent
    // of 5".
    expect(facade.versionCount()).toBe(0);
  });

  it('does not clear a newer request’s versions when an older one fails late', () => {
    // The generation guard `loadOutline` already applies, now applied here too:
    // a failure belonging to the document you just left must not empty the
    // panel of the one you are looking at.
    const responses: Observable<never>[] = [
      throwError(() => new HttpErrorResponse({ status: 500 })),
      page([version(1)], 1),
    ];
    let call = 0;
    const facade = facadeWith({ versions: () => responses[call++] as never });

    facade.load('doc-1'); // its versions fail — generation 1
    facade.load('doc-2'); // its versions arrive — generation 2

    expect(facade.versions().length).toBe(1);
    expect(facade.versionCount()).toBe(1);
  });

  it('keeps the window already on screen when "show older" fails', () => {
    let call = 0;
    const facade = facadeWith({
      versions: () => (++call === 1
        ? page([version(1), version(2)], 5)
        : throwError(() => new HttpErrorResponse({ status: 503 }))) as never,
    });

    facade.load('doc-1');
    expect(facade.versions().length).toBe(2);

    facade.loadMoreVersions();

    // Handled, and deliberately a no-op: the two the person can already see are
    // still true, and revert reads off this list. Throwing them away because a
    // *second* page failed would take away history that still works.
    expect(facade.versions().length).toBe(2);
    expect(facade.versionCount()).toBe(5);
  });
});
