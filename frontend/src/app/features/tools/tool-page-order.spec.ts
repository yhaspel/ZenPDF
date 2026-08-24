import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { Observable, Subject, of } from 'rxjs';

import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { toolBySlug } from '../../core/tool-pages';
import { UploadDropzone } from '../../shared/upload-dropzone';
import { ToolPage } from './tool-page';

/**
 * "Page order follows the order you add the files" — the promise `/merge-pdf`
 * makes on its own page.
 *
 * The uploads run concurrently and the first cut recorded each result with
 * `push`, so `document_ids` reached the server in the order the *network*
 * finished. `tasks.py` merges strictly positionally: add a 20 MB chapter and
 * then a 200 KB cover and the cover merged second, differently on a different
 * connection. `/compare-pdf` shares the call and can invert the diff.
 */
describe('Tool page — the order the visitor chose', () => {
  let sent: { type: string; params: Record<string, unknown> }[];
  let gates: Subject<unknown>[];

  function doc(id: string): DocumentModel {
    return {
      id, title: id, status: 'ready', page_count: 1, size_bytes: 1,
      is_encrypted: false, starred: false, folder: null, metadata: {},
      current_version: { id: 'v1', seq: 1 }, last_opened_at: null,
      trashed_at: null, created_at: '', updated_at: '',
    } as DocumentModel;
  }

  beforeEach(() => {
    sent = [];
    gates = [];
    let n = 0;
    const docs: Partial<DocumentsService> = {
      // Each upload waits on its own gate, so the test decides who finishes
      // first — which is the whole point.
      upload: () => {
        const index = n++;
        const gate = new Subject<unknown>();
        gates[index] = gate;
        return gate.asObservable() as Observable<never>;
      },
      get: (id: string) => of(doc(id)),
      crossOperation: (body) => {
        sent.push(body as never);
        return of({ id: 'job-1', status: 'succeeded', progress: 100,
                    result: { documents: ['out'] } } as unknown as Job);
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: DocumentsService, useValue: docs },
        { provide: JobsFacade, useValue: { dispatch: (c$: Observable<Job>) => c$ } },
        {
          provide: GuestFacade,
          useValue: { ensureSession: () => of(null), principal: () => 'guest' },
        },
      ],
    });
  });

  it('sends the files in the order they were added, not the order they landed', () => {
    const fixture = TestBed.createComponent(ToolPage);
    fixture.componentRef.setInput('tool', toolBySlug('merge-pdf'));
    fixture.detectChanges();

    const dropzone = fixture.debugElement.query(By.directive(UploadDropzone));
    dropzone.componentInstance.filesPicked.emit([
      new File(['%PDF'], 'chapter.pdf'),
      new File(['%PDF'], 'cover.pdf'),
    ]);
    fixture.detectChanges();

    const cta: HTMLButtonElement =
      fixture.nativeElement.querySelector('[data-test=tool-run]');
    expect(cta.disabled).toBe(false);
    cta.click();
    fixture.detectChanges();

    expect(gates.length).toBe(2);
    // The small second file comes back first, as it would on any real network.
    gates[1].next({ body: doc('cover') });
    gates[1].complete();
    gates[0].next({ body: doc('chapter') });
    gates[0].complete();
    fixture.detectChanges();

    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe('merge');
    expect(sent[0].params['document_ids']).toEqual(['chapter', 'cover']);
  });
});

/**
 * Each interactive tool opens the screen it is named after.
 *
 * `organize` was the one entry in the mode map with no mode in it, so
 * "Organize pages" landed in the reading view — the page grid it exists for
 * one unexplained click away.
 */
describe('Tool page — the screen the tool is named after', () => {
  const MODES: Record<string, string> = {
    'organize-pdf': 'organize',
    'annotate-pdf': 'annotate',
    'edit-pdf': 'edit',
    'fill-pdf-form': 'forms',
    'protect-pdf': 'protect',
    'unlock-pdf': 'protect',
    'redact-pdf': 'protect',
    'sign-pdf': 'sign',
  };

  for (const [slug, mode] of Object.entries(MODES)) {
    it(`${slug} opens the workspace in ${mode} mode`, () => {
      const navigated: { path: unknown[]; extras?: { queryParams?: Record<string, string> } }[] = [];
      TestBed.configureTestingModule({
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideRouter([]),
          {
            provide: DocumentsService,
            useValue: {
              upload: () => of({ body: { id: 'doc-1', page_count: 3 } } as never),
              get: (id: string) => of({ id, page_count: 3 }),
            },
          },
          { provide: JobsFacade, useValue: { dispatch: (c$: Observable<Job>) => c$ } },
          { provide: GuestFacade, useValue: { ensureSession: () => of(null), principal: () => 'guest' } },
        ],
      });
      // Spy on the real Router rather than replacing it: `provideRouter` builds
      // one, and a stub in its place leaves the injector half-wired.
      const router = TestBed.inject(Router);
      router.navigate = ((path: unknown[], extras?: never) => {
        navigated.push({ path, extras });
        return Promise.resolve(true);
      }) as never;
      const fixture = TestBed.createComponent(ToolPage);
      fixture.componentRef.setInput('tool', toolBySlug(slug));
      fixture.detectChanges();
      fixture.debugElement.query(By.directive(UploadDropzone))
        .componentInstance.filesPicked.emit([new File(['%PDF'], 'a.pdf')]);
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-test=tool-run]').click();
      fixture.detectChanges();

      expect(navigated.length).toBe(1);
      expect(navigated[0].path).toEqual(['/app/doc', 'doc-1']);
      expect(navigated[0].extras?.queryParams?.['mode']).toBe(mode);
      TestBed.resetTestingModule();
    });
  }
});
