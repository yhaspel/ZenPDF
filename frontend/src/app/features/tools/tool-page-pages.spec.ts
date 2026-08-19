import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { Observable, of } from 'rxjs';

import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { toolBySlug } from '../../core/tool-pages';
import { UploadDropzone } from '../../shared/upload-dropzone';
import { ToolPage } from './tool-page';

/**
 * The page tools, on the pages the visitor actually asked for.
 *
 * Both shipped with `pages: [0]` hardcoded: "Extract PDF pages" extracted page
 * one and nothing else, and "Delete pages" deleted page one — a plural promise
 * that could only ever act on a single page. These tests are the record of what
 * the widget now sends, including the two refusals that must never reach the
 * engine: a page the document does not have, and a selection that would empty
 * it entirely.
 */
describe('Tool page — page selection', () => {
  const PAGES = 7;
  let sent: { id: string; body: { type: string; params: Record<string, unknown> } }[];
  let uploads: number;

  function doc(over: Partial<DocumentModel> = {}): DocumentModel {
    return {
      id: 'doc-1',
      title: 'Report',
      status: 'ready',
      page_count: PAGES,
      size_bytes: 1024,
      is_encrypted: false,
      starred: false,
      folder: null,
      metadata: {},
      current_version: { id: 'v1', seq: 1 },
      last_opened_at: null,
      trashed_at: null,
      created_at: '',
      updated_at: '',
      ...over,
    } as DocumentModel;
  }

  const succeeded = {
    id: 'job-1',
    status: 'succeeded',
    progress: 100,
    result: { documents: ['out-1'] },
  } as unknown as Job;

  function configure() {
    sent = [];
    uploads = 0;
    const docs: Partial<DocumentsService> = {
      upload: () => {
        uploads++;
        return of({ body: doc() } as never) as Observable<never>;
      },
      get: (id: string) => of(doc({ id, title: 'Extracted pages' })),
      operation: (id, body) => {
        sent.push({ id, body: body as never });
        return of(succeeded);
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
  }

  /** A mounted tool page with a file already chosen and `spec` typed in. */
  function widget(slug: string, spec: string) {
    const fixture = TestBed.createComponent(ToolPage);
    fixture.componentRef.setInput('tool', toolBySlug(slug));
    fixture.detectChanges();

    const dropzone = fixture.debugElement.query(By.directive(UploadDropzone));
    dropzone.componentInstance.filesPicked.emit([new File(['%PDF'], 'report.pdf')]);
    fixture.detectChanges();

    const field: HTMLInputElement = fixture.nativeElement.querySelector('[data-test=page-spec]');
    field.value = spec;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    return fixture;
  }

  function run(fixture: ReturnType<typeof widget>) {
    fixture.nativeElement.querySelector('[data-test=tool-run]').click();
    fixture.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  beforeEach(() => configure());

  it('extracts the pages that were typed, 0-based over the wire', () => {
    const fixture = widget('extract-pdf-pages', '3, 1, 5-6');
    run(fixture);

    expect(sent).toHaveLength(1);
    expect(sent[0].body.type).toBe('extract_pages');
    // Typed order preserved — the selection is a running order, not a set.
    expect(sent[0].body.params).toEqual({
      pages: [2, 0, 4, 5],
      as_new_document: true,
      separate: false,
    });
    // And the result says which pages, because the visitor chose them.
    expect(fixture.nativeElement.querySelector('[data-test=tool-result]').textContent)
      .toContain('Pages 1, 3, 5–6 extracted.');
  });

  it('asks for one file per page when that is the chosen result', () => {
    const fixture = widget('extract-pdf-pages', '2, 4');
    fixture.nativeElement.querySelector('[data-test=extract-separate]').click();
    fixture.detectChanges();
    run(fixture);

    expect(sent[0].body.params['separate']).toBe(true);
  });

  it('refuses a page the document does not have, and says how many there are', () => {
    const fixture = widget('extract-pdf-pages', '9');
    run(fixture);

    expect(sent).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('[data-test=tool-error]').textContent)
      .toContain('7 pages');
  });

  it('deletes the pages that were typed, collapsed and in document order', () => {
    run(widget('delete-pdf-pages', '3, 1, 3'));

    expect(sent[0].body.type).toBe('delete_pages');
    expect(sent[0].body.params).toEqual({ pages: [0, 2] });
  });

  it('refuses a deletion that would leave no pages at all', () => {
    const fixture = widget('delete-pdf-pages', '1-7');
    run(fixture);

    expect(sent).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('[data-test=tool-error]').textContent)
      .toContain('at least one');
  });

  it('keeps the button out of reach until the selection makes sense', () => {
    const fixture = widget('extract-pdf-pages', '');
    const button = () => fixture.nativeElement.querySelector('[data-test=tool-run]');
    expect(button().disabled).toBe(true);

    const field: HTMLInputElement = fixture.nativeElement.querySelector('[data-test=page-spec]');
    field.value = 'the first two';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button().disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-test=page-spec-error]').textContent)
      .toContain('not a page number');

    field.value = '2-4';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button().disabled).toBe(false);
  });

  it('does not upload the file a second time when a refused selection is corrected', () => {
    const fixture = widget('extract-pdf-pages', '9');
    run(fixture);
    expect(uploads).toBe(1);
    expect(sent).toHaveLength(0);

    const field: HTMLInputElement = fixture.nativeElement.querySelector('[data-test=page-spec]');
    field.value = '2';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    run(fixture);

    expect(uploads).toBe(1);
    expect(sent[0].body.params['pages']).toEqual([1]);
  });

  it('offers the page field only to the tools that act on a selection', () => {
    const fixture = TestBed.createComponent(ToolPage);
    fixture.componentRef.setInput('tool', toolBySlug('compress-pdf'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test=page-select]')).toBeNull();
  });
});
