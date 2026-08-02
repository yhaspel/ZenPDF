import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ConvertFacade } from './convert.facade';

describe('ConvertFacade', () => {
  let facade: ConvertFacade;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(ConvertFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => facade.reset());

  function finishJob(id = 'j', result?: object) {
    http.expectOne((r) => r.url.endsWith(`/jobs/${id}/`))
      .flush({ id, status: 'succeeded', result });
  }

  it('sends only the OCR options that were asked for', () => {
    // Every flag is a behaviour change — `force` replaces a real text layer
    // with a reading of a picture of it — so an unticked box must not travel.
    facade.ocr('doc-1', 2, { languages: ['eng', 'heb'] }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('ocr');
    expect(req.request.body.params).toEqual({ languages: ['eng', 'heb'] });
    expect(req.request.body.base_version_seq).toBe(2);
    req.flush({ id: 'j', status: 'succeeded' });
    finishJob();
  });

  it('passes the cleanup flags when they are ticked', () => {
    facade.ocr('doc-1', 1, {
      languages: ['eng'], deskew: true, clean: true, rotate_pages: true, force: true,
    }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.params).toEqual({
      languages: ['eng'], deskew: true, rotate_pages: true, clean: true, force: true,
    });
    req.flush({ id: 'j', status: 'succeeded' });
    finishJob();
  });

  it('only sends image options for the image export', () => {
    facade.exportAs('doc-1', 1, 'docx').subscribe();
    const docx = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(docx.request.body.params).toEqual({ format: 'docx' });
    docx.flush({ id: 'j1', status: 'succeeded' });
    finishJob('j1');

    facade.exportAs('doc-1', 1, 'images', { dpi: 200, imageFormat: 'jpg' }).subscribe();
    const images = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(images.request.body.params).toEqual({
      format: 'images', dpi: 200, image_format: 'jpg',
    });
    images.flush({ id: 'j2', status: 'succeeded' });
    finishJob('j2');
  });

  it('remembers the finished export so it can be downloaded', () => {
    facade.exportAs('doc-1', 1, 'txt').subscribe();
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'))
      .flush({ id: 'j', status: 'succeeded' });
    finishJob('j', { export: { filename: 'document.txt' } });

    expect(facade.exportName()).toBe('document.txt');

    facade.download(facade.lastExport()!).subscribe();
    const download = http.expectOne((r) => r.url.endsWith('/jobs/j/download/'));
    expect(download.request.responseType).toBe('blob');
    download.flush(new Blob(['hello']));
  });

  it('uploads a file and converts it in one call', () => {
    // The ref is useless on its own, so the facade never hands one back — a
    // caller that had to remember to run the second half would forget.
    facade.importFile(new File(['x'], 'letter.docx')).subscribe();

    const upload = http.expectOne((r) => r.url.endsWith('/uploads/source/'));
    expect(upload.request.body instanceof FormData).toBe(true);
    upload.flush({ ref: 'abc123', filename: 'letter.docx', size_bytes: 1, kind: 'office' });

    const op = http.expectOne((r) => r.url.endsWith('/operations/'));
    expect(op.request.body.type).toBe('convert_from');
    expect(op.request.body.params).toEqual({ upload_ref: 'abc123', filename: 'letter.docx' });
    op.flush({ id: 'j', status: 'succeeded' });
    finishJob();
  });

  it('converts a web address', () => {
    facade.importUrl('https://example.com/report').subscribe();
    const op = http.expectOne((r) => r.url.endsWith('/operations/'));
    expect(op.request.body.params).toEqual({ url: 'https://example.com/report' });
    op.flush({ id: 'j', status: 'succeeded' });
    finishJob();
  });

  it('repairs a document', () => {
    facade.repair('doc-1', 3).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('repair');
    expect(req.request.body.base_version_seq).toBe(3);
    req.flush({ id: 'j', status: 'succeeded' });
    finishJob();
  });

  it('clears busy when the request itself errors — the metered-cap path', () => {
    // Every one of these operations is metered (§16), so a guest's sixth
    // export in an hour is a 429. `map` only runs on the value channel, so the
    // flag stayed on and — the facade being a root singleton — stayed on
    // across navigation too: the panel was dead until a page reload.
    facade.exportAs('doc-1', 1, 'docx').subscribe({ error: () => undefined });
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'))
      .flush({ error: { code: 'quota_exceeded' } }, { status: 429, statusText: 'Too Many' });
    expect(facade.busy()).toBe(false);
  });

  it('clears busy when the source upload errors', () => {
    facade.importFile(new File(['x'], 'letter.docx')).subscribe({ error: () => undefined });
    http.expectOne((r) => r.url.endsWith('/uploads/source/'))
      .flush({ error: { code: 'file_too_large' } }, { status: 413, statusText: 'Too Large' });
    expect(facade.busy()).toBe(false);
  });

  it('sends several images as ONE conversion', () => {
    // `/jpg-to-pdf` promises "add them all and each becomes a page". One job
    // per file gave N separate documents and orphaned all but one.
    facade.importImages([new File(['a'], 'a.png'), new File(['b'], 'b.png')]).subscribe();

    const uploads = http.match((r) => r.url.endsWith('/uploads/source/'));
    expect(uploads.length).toBe(2);
    uploads[0].flush({ ref: 'r1', filename: 'a.png', size_bytes: 1, kind: 'image' });
    uploads[1].flush({ ref: 'r2', filename: 'b.png', size_bytes: 1, kind: 'image' });

    const op = http.expectOne((r) => r.url.endsWith('/operations/'));
    expect(op.request.body.params.upload_refs).toEqual(['r1', 'r2']);
    op.flush({ id: 'j', status: 'succeeded' });
    finishJob();
  });

  it('clears busy when a job fails, not only when it succeeds', () => {
    facade.exportAs('doc-1', 1, 'docx').subscribe();
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'))
      .flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/'))
      .flush({ id: 'j', status: 'failed', error_message: 'nope' });
    expect(facade.busy()).toBe(false);
    expect(facade.lastExport()).toBeNull();
  });
});
