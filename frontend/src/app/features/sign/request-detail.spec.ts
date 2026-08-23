import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { EMPTY, of } from 'rxjs';

import { SignRequestModel } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { RequestDetail } from './request-detail';

/**
 * The append notice (queue row 2026-08-02).
 *
 * `_append_to_source_document` is best-effort by design — the envelope is
 * complete and the sealed file downloadable either way — and it used to put its
 * reason in a server log and nowhere else. Since the storage quota moved onto
 * the version write, "you are over quota" became one of the routine reasons, so
 * the owner whose document never received the signed copy could be told nothing
 * at all about why.
 *
 * Two assertions carry this file, and the second is the one that would catch a
 * regression: the notice must be **absent** on the happy path. A notice that is
 * always rendered is worse than none.
 */
describe('RequestDetail — the signed copy that did not land', () => {
  let fixture: ComponentFixture<RequestDetail>;

  const COMPLETED: SignRequestModel = {
    id: 'req-1',
    document: 'doc-1',
    document_title: 'Offer',
    title: 'Offer',
    message: '',
    status: 'completed',
    envelope_code: 'ZEN-8F3KQ2',
    expires_at: null,
    reminder_every_days: 3,
    sent_at: '2026-08-23T09:00:00Z',
    completed_at: '2026-08-23T10:00:00Z',
    final_sha256: 'a'.repeat(64),
    created_at: '2026-08-23T08:00:00Z',
    recipients: [],
    fields_: [],
    page_count: 1,
    source_append_error: null,
  };

  function render(request: SignRequestModel): void {
    const fakeEsign: Partial<EsignService> = {
      getRequest: () => of(request) as never,
      audit: () => EMPTY as never,
    };
    TestBed.configureTestingModule({
      imports: [RequestDetail],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: EsignService, useValue: fakeEsign },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'req-1' }) } },
        },
      ],
    });
    fixture = TestBed.createComponent(RequestDetail);
    fixture.detectChanges();
  }

  const notice = () =>
    fixture.nativeElement.querySelector('[data-test="append-error"]') as HTMLElement | null;

  afterEach(() => TestBed.resetTestingModule());

  it('renders nothing on the happy path', () => {
    render(COMPLETED);
    expect(notice()).toBeNull();
  });

  it('renders the reason, verbatim, when the append declined', () => {
    render({
      ...COMPLETED,
      source_append_error:
        'That would take you past your 2048 MB of storage. Empty your trash or '
        + 'delete a document to free some up.',
    });

    const shown = notice();
    expect(shown).not.toBeNull();
    expect(shown!.textContent).toContain('could not be added to your document');
    expect(shown!.textContent).toContain('past your 2048 MB of storage');
    // The sentence points at the downloads, so it must be true that they are
    // still offered — that is the whole reassurance the notice carries.
    expect(shown!.textContent).toContain('sealed file and certificate are');
  });

  it('takes the contract notice treatment, not a toast or a bare paragraph', () => {
    render({ ...COMPLETED, source_append_error: 'Something went wrong.' });

    const shown = notice()!;
    expect(shown.classList).toContain('notice');
    expect(shown.classList).toContain('notice-warning');
  });

  it('leaves both downloads reachable beside it', () => {
    render({ ...COMPLETED, source_append_error: 'Over quota.' });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-test="download-final"]')).not.toBeNull();
    expect(root.querySelector('[data-test="download-certificate"]')).not.toBeNull();
  });

  it('says nothing while the request is still out for signature', () => {
    // The field is only ever written by the finalize, so a `sent` request
    // carrying one would be a bug — and rendering it under "waiting on Sam"
    // would read as a failure of the thing that has not happened yet.
    render({ ...COMPLETED, status: 'sent', source_append_error: 'Over quota.' });
    expect(notice()).toBeNull();
  });
});
