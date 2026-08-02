import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { EsignFacade, dataUrlToFile } from './esign.facade';

const RECT = { x: 0.1, y: 0.7, w: 0.3, h: 0.06 };
// A 1×1 PNG, which is all the browser-free test environment needs.
const DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4'
  + '2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('EsignFacade', () => {
  let facade: EsignFacade;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(EsignFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => facade.reset());

  it('turns a data URL into a file without a network round trip', async () => {
    const file = await new Promise<File>((resolve, reject) =>
      dataUrlToFile(DATA_URL, 'signature.png').subscribe({
        next: resolve, error: reject,
      }));
    expect(file.name).toBe('signature.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBeGreaterThan(0);
  });

  it('parks a drawn signature as an ephemeral asset — the guest path', () => {
    facade.useImage(DATA_URL).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/uploads/image/'));
    expect(req.request.body instanceof FormData).toBe(true);
    req.flush({ ref: 'abc123ref', width: 1, height: 1, content_type: 'image/png' });

    expect(facade.hasSignature()).toBe(true);
    expect(facade.preview()).toBe(DATA_URL);
  });

  it('sends an upload ref, not a saved id, when the signature is ephemeral', () => {
    facade.useImage(DATA_URL).subscribe();
    http.expectOne((r) => r.url.endsWith('/uploads/image/'))
      .flush({ ref: 'abc123ref', width: 1, height: 1, content_type: 'image/png' });
    facade.place(0, RECT);

    facade.apply('doc-1', 2, true).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('self_sign');
    expect(req.request.body.params.placements).toEqual([
      { signature_upload_ref: 'abc123ref', page: 0, rect: RECT },
    ]);
    expect(req.request.body.params.include_date).toBe(true);
    expect(req.request.body.base_version_seq).toBe(2);
    req.flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/'))
      .flush({ id: 'j', status: 'succeeded' });
  });

  it('sends a saved id when the user picked one from their library', () => {
    facade.chooseSaved({
      id: 'sig-1', kind: 'signature', method: 'draw', typed_text: '', font: '',
      is_default: true, created_at: '',
    });
    facade.place(1, RECT);

    facade.apply('doc-1', null, false).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.params.placements).toEqual([
      { signature_id: 'sig-1', page: 1, rect: RECT },
    ]);
    req.flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/'))
      .flush({ id: 'j', status: 'succeeded' });
  });

  it('swallows the 403 a guest gets for the signature library', () => {
    // A guest has no library. That is not an error worth showing them — the
    // pad is right there, and the whole point of §21.3 is no dead ends.
    facade.loadSaved();
    http.expectOne((r) => r.url.endsWith('/signatures/'))
      .flush({ error: { code: 'account_required' } },
             { status: 403, statusText: 'Forbidden' });
    expect(facade.saved()).toEqual([]);
  });

  it('never reuses a placement id after a removal', () => {
    facade.place(0, RECT);
    facade.place(0, RECT);
    const [first, second] = facade.placements();
    facade.unplace(first.id);
    facade.place(0, RECT);

    const ids = facade.placements().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(second.id);
  });

  it('forgets the signature and the placements on reset', () => {
    facade.chooseSaved({
      id: 'sig-1', kind: 'signature', method: 'draw', typed_text: '', font: '',
      is_default: false, created_at: '',
    });
    facade.place(0, RECT);
    facade.reset();

    expect(facade.hasSignature()).toBe(false);
    expect(facade.placements()).toEqual([]);
    expect(facade.preview()).toBeNull();
  });
});
