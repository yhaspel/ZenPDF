import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';

import { DocumentModel } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { Workspace } from './workspace';

/**
 * M7 — what the workspace shows when the document will not load.
 *
 * `workspace.html` gated its entire body on a truthy `viewer.doc()` with no
 * `@else`. A stale or foreign `/app/doc/:id`, a 500, or an offline browser
 * therefore rendered *nothing*: a white screen, no message, no way back — at
 * the moment the person is least able to guess what happened.
 */
describe('Workspace failure states', () => {
  function configure(get: () => Observable<DocumentModel>) {
    const fakeDocs: Partial<DocumentsService> = {
      get,
      versions: () => of({ count: 0, next: null, previous: null, results: [] }) as never,
      outline: () => of({ outline: [] }) as never,
      contentUrl: () => '',
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: DocumentsService, useValue: fakeDocs },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'doc-1' })),
            queryParamMap: of(convertToParamMap({})),
            snapshot: { paramMap: convertToParamMap({ id: 'doc-1' }) },
          },
        },
      ],
    });
  }

  afterEach(() => TestBed.resetTestingModule());

  it('shows the reason and a way out instead of a blank screen', () => {
    configure(() =>
      throwError(() => ({
        status: 404,
        error: {
          error: { code: 'not_found', message: 'That document could not be found.', details: {} },
        },
      })),
    );

    const fixture = TestBed.createComponent(Workspace);
    fixture.detectChanges();
    const html: HTMLElement = fixture.nativeElement;

    const error = html.querySelector('[data-test=workspace-error]');
    expect(error).toBeTruthy();
    expect(html.querySelector('[data-test=workspace-error-message]')?.textContent).toContain(
      'could not be found',
    );
    // Two ways forward: retry the id that is still in the URL, or leave.
    expect(html.querySelector('[data-test=workspace-retry]')).toBeTruthy();
    expect(html.querySelector('[data-test=workspace-error-home]')).toBeTruthy();
    // Announced, not just drawn: this replaces the whole view.
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('says the guest session ended, in the words a guest needs', () => {
    configure(() =>
      throwError(() => ({
        status: 410,
        error: {
          error: { code: 'guest_expired', message: 'Your guest session ended.', details: {} },
        },
      })),
    );

    const fixture = TestBed.createComponent(Workspace);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Your guest session ended.');
    expect(text).toContain('deleted automatically');
  });

  it('retries the id in the URL when asked', () => {
    let calls = 0;
    configure(() => {
      calls += 1;
      return throwError(() => ({ status: 500, error: null }));
    });

    const fixture = TestBed.createComponent(Workspace);
    fixture.detectChanges();
    expect(calls).toBe(1);

    fixture.nativeElement
      .querySelector('[data-test=workspace-retry]')
      .dispatchEvent(new Event('click'));
    fixture.detectChanges();

    expect(calls).toBe(2);
    expect(fixture.nativeElement.querySelector('[data-test=workspace-error]')).toBeTruthy();
  });
});
