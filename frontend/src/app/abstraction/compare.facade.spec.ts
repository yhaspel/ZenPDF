import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { CompareReport } from '../core/models/models';
import { CompareFacade } from './compare.facade';

const RECT = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };

const REPORT: CompareReport = {
  pages: [
    {
      a_page: 0,
      b_page: 0,
      text_changes: [
        { kind: 'replace', a_text: 'twelve', b_text: 'thirty', a_rect: RECT, b_rect: RECT },
        { kind: 'insert', a_text: '', b_text: 'An extra line', a_rect: null, b_rect: RECT },
      ],
      visual_regions: [],
      visual_share: 0,
    },
    {
      a_page: 1,
      b_page: 1,
      text_changes: [],
      visual_regions: [{ x: 0.3, y: 0.35, w: 0.4, h: 0.15 }],
      visual_share: 0.06,
    },
  ],
  summary: {
    a_pages: 2, b_pages: 2, offset: 0, changed_pages: 2, text_changes: 2, identical: false,
  },
};

describe('CompareFacade', () => {
  let facade: CompareFacade;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(CompareFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => facade.reset());

  function run(): void {
    facade.setOther('doc-b');
    facade.run('doc-a', 1)!.subscribe();
    http.expectOne((r) => r.url.endsWith('/documents/doc-a/operations/'))
      .flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/'))
      .flush({ id: 'j', status: 'succeeded', result: { report: REPORT } });
  }

  it('will not run without something to compare against', () => {
    expect(facade.run('doc-a', 1)).toBeNull();
  });

  it('sends the other document and the offset', () => {
    facade.setOther('doc-b');
    facade.setOffset(2);
    facade.run('doc-a', 1)!.subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-a/operations/'));
    expect(req.request.body.type).toBe('compare');
    expect(req.request.body.params).toEqual({ other_document_id: 'doc-b', offset: 2 });
    req.flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/'))
      .flush({ id: 'j', status: 'succeeded', result: { report: REPORT } });
  });

  it('flattens the report into one clickable list', () => {
    run();
    const rows = facade.changes();
    expect(rows.length).toBe(3);
    expect(rows[0].summary).toBe('Changed: “twelve” → “thirty”');
    expect(rows[1].summary).toBe('Added: “An extra line”');
    expect(rows[2].kind).toBe('visual');
    // Every row knows which page pair it belongs to, which is what lets a
    // click move both sides at once.
    expect(rows[2].pageIndex).toBe(1);
    expect(rows[2].aPage).toBe(1);
    expect(rows[2].bPage).toBe(1);
  });

  it('gives each side only the rects that side has', () => {
    run();
    // The inserted line exists only in B, so A must not get a highlight for it.
    expect(facade.rectsFor('a', 0).length).toBe(1);
    expect(facade.rectsFor('b', 0).length).toBe(2);
    expect(facade.rectsFor('a', 1).length).toBe(1);
  });

  it('tracks the selected change', () => {
    run();
    expect(facade.selected()).toBeNull();
    facade.select(facade.changes()[1].id);
    expect(facade.selected()!.summary).toBe('Added: “An extra line”');
  });

  it('clears running when the request errors', () => {
    // Compare is metered too, so a 429 here left the Compare button disabled
    // for the rest of the session.
    facade.setOther('doc-b');
    facade.run('doc-a', 1)!.subscribe({ error: () => undefined });
    http.expectOne((r) => r.url.endsWith('/documents/doc-a/operations/'))
      .flush({ error: { code: 'quota_exceeded' } }, { status: 429, statusText: 'Too Many' });
    expect(facade.running()).toBe(false);
  });

  it('drops the report when the other document changes', () => {
    run();
    expect(facade.report()).not.toBeNull();
    facade.setOther('doc-c');
    expect(facade.report()).toBeNull();
    expect(facade.selectedId()).toBeNull();
  });

  it('reports an identical pair as identical', () => {
    facade.setOther('doc-b');
    facade.run('doc-a', 1)!.subscribe();
    http.expectOne((r) => r.url.endsWith('/documents/doc-a/operations/'))
      .flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({
      id: 'j', status: 'succeeded',
      result: {
        report: {
          pages: [],
          summary: { a_pages: 2, b_pages: 2, offset: 0, changed_pages: 0,
                     text_changes: 0, identical: true },
        },
      },
    });
    expect(facade.summary()!.identical).toBe(true);
    expect(facade.changes()).toEqual([]);
    // The identical sentence is the template's own; the line stands down.
    expect(facade.summaryLine()).toBeNull();
  });

  // ------------------------------------------------------------------ //
  // "4 of 2 page(s) differ" (2026-08-21 report, smaller observations)
  //
  // `changed_pages` counts the positions compared — the union of both
  // documents — and `a_pages` counts only this one, so the sentence put a
  // union numerator over a single-document denominator and read as nonsense
  // the moment the other document was the longer one.
  // ------------------------------------------------------------------ //

  /** A report of `entries` page pairs; `null` on a side means "no such page". */
  function load(
    entries: [number | null, number | null][],
    summary: Partial<CompareReport['summary']> & { a_pages: number; b_pages: number },
  ): void {
    const report: CompareReport = {
      pages: entries.map(([a, b]) => ({
        a_page: a, b_page: b, text_changes: [], visual_regions: [], visual_share: 0,
      })),
      summary: {
        offset: 0, changed_pages: entries.length, text_changes: entries.length,
        identical: false, ...summary,
      },
    };
    facade.setOther('doc-b');
    facade.run('doc-a', 1)!.subscribe();
    http.expectOne((r) => r.url.endsWith('/documents/doc-a/operations/'))
      .flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/'))
      .flush({ id: 'j', status: 'succeeded', result: { report } });
  }

  it('states one denominator when the two documents are the same length', () => {
    load([[0, 0], [1, 1], [2, 2]], { a_pages: 3, b_pages: 3, changed_pages: 2, text_changes: 5 });
    expect(facade.summaryLine()).toBe('2 of 3 pages differ · 5 text changes');
  });

  it('names both lengths when this document is the longer one', () => {
    load([[0, 0], [1, 1], [2, null], [3, null]],
      { a_pages: 4, b_pages: 2, changed_pages: 3, text_changes: 5 });
    expect(facade.summaryLine()).toBe(
      'Compared 4 pages against 2 — 3 pages differ (2 only exist in this document) '
      + '· 5 text changes',
    );
  });

  it('names both lengths when the other document is the longer one', () => {
    // The measured case: 4 changed pages, 2 of them this document's whole length.
    load([[0, 0], [1, 1], [null, 2], [null, 3]],
      { a_pages: 2, b_pages: 4, changed_pages: 4, text_changes: 4 });
    expect(facade.summaryLine()).toBe(
      'Compared 2 pages against 4 — 4 pages differ (2 only exist in the other document) '
      + '· 4 text changes',
    );
  });

  it('counts the unpaired pages an offset leaves on each side, not the difference', () => {
    // Two 3-page files at offset 1: B's first page and A's last have no
    // counterpart, and `|a_pages − b_pages|` is zero — which is why the count
    // comes off the report rather than off the two lengths.
    load([[null, 0], [0, 1], [1, 2], [2, null]],
      { a_pages: 3, b_pages: 3, offset: 1, changed_pages: 2, text_changes: 2 });
    expect(facade.summaryLine()).toBe(
      'Compared 3 pages against 3 — 2 pages differ '
      + '(1 only exists in this document, 1 only exists in the other document) · 2 text changes',
    );
  });

  it('says it in the singular where the singular is what happened', () => {
    load([[0, 0], [1, 1]], { a_pages: 2, b_pages: 2, changed_pages: 1, text_changes: 1 });
    expect(facade.summaryLine()).toBe('1 of 2 pages differs · 1 text change');
  });
});
