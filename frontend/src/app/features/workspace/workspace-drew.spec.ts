import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { DocumentModel } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ViewerFacade } from '../../abstraction/viewer.facade';
import { Workspace } from './workspace';

/**
 * `data-test=viewer-drew` — the marker the e2e suite reads to know a page was
 * painted, rather than that a request returned 200.
 *
 * The property under test is that the claim is about the **bytes currently in
 * `src`**. A boolean set once at the first `pageRendered` would keep claiming
 * "the page drew" through a save, a revert and a refresh-retry — precisely the
 * moments when the viewer is showing nothing yet, and precisely the false pass
 * this whole change exists to prevent.
 */
describe('Workspace — the page-drew marker', () => {
  let seq: number;

  function build() {
    seq = 1;
    const doc = (): DocumentModel =>
      ({
        id: 'doc-1',
        title: 'A file',
        // Zero pages keeps the thumbnail rail out of the fixture: this spec is
        // about the marker, and a rail of `app-pdf-thumbnail` would drag the
        // whole raster pipeline in with it.
        page_count: 0,
        current_version: { id: `v${seq}`, seq, label: 'Uploaded' },
      }) as DocumentModel;

    const fakeDocs: Partial<DocumentsService> = {
      get: () => of(doc()) as never,
      versions: () => of({ count: 0, next: null, previous: null, results: [] }) as never,
      outline: () => of({ outline: [] }) as never,
      contentUrl: (id: string, version?: number) => `/c/${id}/${version}`,
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
    const fixture = TestBed.createComponent(Workspace);
    fixture.detectChanges();
    return {
      fixture,
      viewer,
      ws: fixture.componentInstance as unknown as {
        pageDrawn(): boolean;
        onPageRendered(): void;
      },
    };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('claims nothing before pdf.js has painted anything', () => {
    const { ws } = build();
    expect(ws.pageDrawn()).toBe(false);
  });

  it('claims the page drew once pageRendered fires', () => {
    const { ws } = build();
    ws.onPageRendered();
    expect(ws.pageDrawn()).toBe(true);
  });

  it('withdraws the claim the moment a new version replaces the bytes', () => {
    const { ws, viewer } = build();
    ws.onPageRendered();
    expect(ws.pageDrawn()).toBe(true);

    // A save appended v2 and the document was refetched: `src` now points at
    // bytes nothing has drawn yet.
    seq = 2;
    viewer.load('doc-1');
    expect(ws.pageDrawn()).toBe(false);

    ws.onPageRendered();
    expect(ws.pageDrawn()).toBe(true);
  });

  it('puts the attribute on the reading pane only while the claim holds', () => {
    const { fixture, ws } = build();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('[data-test=viewer-drew]')).toBeNull();

    ws.onPageRendered();
    fixture.detectChanges();
    expect(host.querySelector('[data-test=viewer-drew]')).not.toBeNull();
  });
});
