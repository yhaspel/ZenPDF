import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { PageTextBlocks, TextBlock } from '../core/models/models';
import { EditFacade } from './edit.facade';

const BLOCK: TextBlock = {
  block_id: 0,
  bbox: { x: 0.1, y: 0.1, w: 0.6, h: 0.05 },
  lines: [{
    bbox: { x: 0.1, y: 0.1, w: 0.6, h: 0.05 },
    spans: [{ text: 'Hello', font: 'Helvetica', size: 12, color: '#000000',
              bold: false, italic: false, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 } }],
  }],
  text: 'Hello world',
};

const MODEL: PageTextBlocks = {
  page: 0, width: 595, height: 842, rotation: 0,
  is_scanned_page: false, blocks: [BLOCK],
};

describe('EditFacade', () => {
  let facade: EditFacade;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(EditFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => facade.reset());

  function loadPage(model: PageTextBlocks = MODEL, docId = 'doc-1', page = 0): void {
    facade.load(docId, page, 1);
    http.expectOne((r) => r.url.endsWith(`/documents/${docId}/text-blocks/`)).flush(model);
    http.expectOne((r) => r.url.endsWith(`/documents/${docId}/images/`))
      .flush({ page, images: [] });
    http.expectOne((r) => r.url.endsWith(`/documents/${docId}/links/`))
      .flush({ page, links: [] });
  }

  it('loads the three read models for a page, once', () => {
    loadPage();
    expect(facade.blocksFor(0).length).toBe(1);
    expect(facade.isScanned(0)).toBe(false);
    expect(facade.aspectFor(0)).toBeCloseTo(842 / 595, 5);

    facade.load('doc-1', 0, 1); // cached
    http.verify();
  });

  it('reports a scanned page so the editor can refuse', () => {
    loadPage({ ...MODEL, is_scanned_page: true, blocks: [] });
    expect(facade.isScanned(0)).toBe(true);
  });

  it('stages an edit and clears it when the text is put back', () => {
    loadPage();
    expect(facade.dirty()).toBe(false);

    facade.stageEdit(BLOCK, 0, 'Something else', { size: 12 });
    expect(facade.dirty()).toBe(true);
    expect(facade.editFor(0, 0)!.new_text).toBe('Something else');

    // Typing the original back is not an edit — sending it would re-render the
    // block through redact-and-reinsert for no reason.
    facade.stageEdit(BLOCK, 0, 'Hello world', { size: 12 });
    expect(facade.dirty()).toBe(false);
  });

  it('keeps edits to the same block number on different pages apart', () => {
    // `block_id` is PyMuPDF's *per-page* number and restarts at 0 on each page,
    // so keying on it alone lost one of these — and prefilled the editor for
    // page 2 with the text typed on page 1.
    loadPage();
    facade.stageEdit(BLOCK, 0, 'EDIT ON PAGE 1', { size: 12 });
    facade.stageEdit(BLOCK, 1, 'EDIT ON PAGE 2', { size: 12 });

    expect(facade.pendingEdits().length).toBe(2);
    expect(facade.editFor(0, 0)!.new_text).toBe('EDIT ON PAGE 1');
    expect(facade.editFor(1, 0)!.new_text).toBe('EDIT ON PAGE 2');

    // Reverting page 1 leaves page 2 staged.
    facade.stageEdit(BLOCK, 0, 'Hello world', { size: 12 });
    expect(facade.pendingEdits().length).toBe(1);
    expect(facade.editFor(1, 0)!.new_text).toBe('EDIT ON PAGE 2');
  });

  it('remembers which query a report belongs to', () => {
    facade.rememberQuery('cat', false);
    expect(facade.reportQuery()).toEqual({ find: 'cat', matchCase: false });
    facade.reset();
    expect(facade.reportQuery()).toBeNull();
  });

  it('commits every staged block as ONE edit_text job', () => {
    loadPage();
    facade.stageEdit(BLOCK, 0, 'First', { size: 12 });
    facade.stageEdit({ ...BLOCK, block_id: 1 }, 0, 'Second', { size: 12 });

    facade.commitEdits('doc-1', 3)!.subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('edit_text');
    expect(req.request.body.params.edits.length).toBe(2);
    expect(req.request.body.base_version_seq).toBe(3);
    req.flush({ id: 'job-1', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/job-1/'))
      .flush({ id: 'job-1', status: 'succeeded' });
  });

  it('commitEdits is a no-op with nothing staged', () => {
    loadPage();
    expect(facade.commitEdits('doc-1', 1)).toBeNull();
  });

  it('switching document drops the previous page cache', () => {
    loadPage();
    facade.stageEdit(BLOCK, 0, 'Changed', {});
    loadPage(MODEL, 'doc-2');
    expect(facade.dirty()).toBe(false);
  });

  describe('find & replace review', () => {
    const report = {
      query: 'page', count: 3, replaced: 0, dry_run: true,
      matches: [
        { id: 'p0:0', page: 0, rect: { x: 0, y: 0, w: 0.1, h: 0.01 }, context: 'one' },
        { id: 'p0:1', page: 0, rect: { x: 0, y: 0, w: 0.1, h: 0.01 }, context: 'two' },
        { id: 'p1:0', page: 1, rect: { x: 0, y: 0, w: 0.1, h: 0.01 }, context: 'three' },
      ],
    };

    it('keeps every match until one is unticked', () => {
      facade.setReport(report);
      expect(facade.keptIds()).toEqual(['p0:0', 'p0:1', 'p1:0']);

      facade.toggleMatch('p0:1');
      expect(facade.keptIds()).toEqual(['p0:0', 'p1:0']);

      facade.toggleMatch('p0:1');
      expect(facade.keptIds().length).toBe(3);
    });

    it('sends only the kept ids on execute', () => {
      facade.setReport(report);
      facade.toggleMatch('p0:0');
      facade.execute('doc-1', 2, 'page', 'sheet', false).subscribe();

      const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
      expect(req.request.body.params.only).toEqual(['p0:1', 'p1:0']);
      expect(req.request.body.params.dry_run).toBeUndefined();
      req.flush({ id: 'j', status: 'succeeded' });
      http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({ id: 'j', status: 'succeeded' });
    });

    it('asks for a dry run first', () => {
      facade.preview('doc-1', 2, 'page', true).subscribe();
      const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
      expect(req.request.body.params.dry_run).toBe(true);
      expect(req.request.body.params.match_case).toBe(true);
      req.flush({ id: 'j', status: 'succeeded' });
      http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({ id: 'j', status: 'succeeded' });
    });
  });
});
