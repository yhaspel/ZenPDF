import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ViewerFacade } from '../../abstraction/viewer.facade';
import { Workspace } from './workspace';

/**
 * Every mode that produces a version hands the **job** on, not a shrug.
 *
 * The six panels have emitted `output<Job>()` since Phase 3. The workspace
 * template dropped the `$event` on all six bindings and every handler was a
 * bare `viewer.reload()`, so the new `seq` the server had already reported was
 * thrown away and re-fetched — and for the length of that GET, `currentSeq()`
 * was a version behind. Anything dispatched in that window came back
 * `version_conflict`. That is the whole 2026-08-02 flake, and it was two lines
 * of receiver, not six components.
 *
 * These tests are deliberately about *forwarding*, not about the outcome: the
 * facade's own spec covers what `adopt` does with the job. What can regress
 * here is somebody re-writing a handler as `reload()` and nothing noticing.
 */
describe('Workspace — a save forwards its job', () => {
  const JOB = (seq: number): Job =>
    ({ id: `j${seq}`, status: 'succeeded', result: { seq } }) as unknown as Job;

  function build() {
    const fakeDocs: Partial<DocumentsService> = {
      get: () =>
        of({
          id: 'doc-1',
          title: 'A file',
          page_count: 0,
          current_version: { id: 'v1', seq: 1, label: 'Uploaded' },
        } as DocumentModel) as never,
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

    const viewer = TestBed.inject(ViewerFacade);
    const adopted: Job[] = [];
    const reloaded: number[] = [];
    viewer.adopt = (job: Job) => void adopted.push(job);
    viewer.reload = () => void reloaded.push(1);

    const fixture = TestBed.createComponent(Workspace);
    fixture.detectChanges();
    return {
      adopted,
      reloaded,
      ws: fixture.componentInstance as unknown as Record<string, (job: Job) => void>,
    };
  }

  afterEach(() => TestBed.resetTestingModule());

  const HANDLERS = [
    'onEditSaved',
    'onFormsSaved',
    'onAnnotationsSaved',
    'onConvertSaved',
    'onProtectSaved',
    'onSigned',
  ];

  for (const [index, handler] of HANDLERS.entries()) {
    it(`${handler} adopts the job it was given`, () => {
      const { ws, adopted, reloaded } = build();
      const job = JOB(index + 2);
      ws[handler](job);
      expect(adopted).toEqual([job]);
      expect(reloaded).toEqual([]);
    });
  }

  it('the operations the workspace runs itself adopt too', () => {
    // rotate, delete, duplicate, insert, scale, n-up, compress and revert all
    // land in `trackReload`, which had the job in hand the whole time.
    const { ws, adopted } = build();
    const job = JOB(9);
    (ws as unknown as { trackReload(j: Job, label: string): void }).trackReload(job, 'Rotated');
    expect(adopted).toEqual([job]);
  });

  it('a version_conflict still reloads — there is no new version to adopt', () => {
    const { ws, adopted, reloaded } = build();
    const failed = {
      id: 'j9',
      status: 'failed',
      error_code: 'version_conflict',
      result: null,
    } as unknown as Job;
    (ws as unknown as { handleFailure(j: Job): void }).handleFailure(failed);
    expect(adopted).toEqual([]);
    expect(reloaded).toEqual([1]);
  });
});
