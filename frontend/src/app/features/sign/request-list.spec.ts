import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SignRecipient, SignRequestModel } from '../../core/models/models';
import { RequestList } from './request-list';

/**
 * `/app/sign` (§7, 8B): what I have sent out and where each one has got to.
 * The per-recipient chips are the point — "where has it got to" is answered
 * from the list, without opening anything.
 */
describe('RequestList', () => {
  let fixture: ComponentFixture<RequestList>;
  let http: HttpTestingController;

  const recipient = (over: Partial<SignRecipient>): SignRecipient => ({
    id: 'r', email: 'r@example.com', name: '', role: 'signer', order: 1,
    status: 'pending', completed_at: null, last_notified_at: null, decline_reason: '',
    ...over,
  });

  const request = (over: Partial<SignRequestModel>): SignRequestModel => ({
    id: 'req', document: 'doc', document_title: 'Doc', title: 'Doc', message: '',
    status: 'sent', envelope_code: 'ZEN-000000', expires_at: null, reminder_every_days: 3,
    sent_at: null, completed_at: null, final_sha256: '', created_at: '2026-08-23T08:00:00Z',
    recipients: [], fields_: [], page_count: 1, source_append_error: null,
    ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RequestList],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RequestList);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const rows = () => [...root().querySelectorAll('[data-test="request-row"]')];
  const empty = () => root().querySelector('[data-test="no-requests"]');

  function answer(results: SignRequestModel[]): void {
    const req = http.expectOne('/api/sign-requests/');
    expect(req.request.method).toBe('GET');
    req.flush({ results });
    fixture.detectChanges();
  }

  it('shows neither rows nor the empty state while the list is loading', () => {
    expect(rows()).toEqual([]);
    expect(empty()).toBeNull();
    http.expectOne('/api/sign-requests/').flush({ results: [] });
  });

  it('shows the empty state once an empty list has arrived', () => {
    answer([]);
    expect(empty()).not.toBeNull();
    expect(empty()!.textContent).toContain('Nothing sent yet.');
    expect(rows()).toEqual([]);
  });

  it('lists each request with a link to its detail page', () => {
    answer([
      request({ id: 'req-1', title: 'Offer', envelope_code: 'ZEN-8F3KQ2' }),
      request({ id: 'req-2', title: 'NDA', envelope_code: 'ZEN-NDA001' }),
    ]);
    expect(empty()).toBeNull();
    expect(rows().length).toBe(2);
    const links = rows().map((row) => row.querySelector('a')!.getAttribute('href'));
    expect(links).toEqual(['/app/sign/req-1', '/app/sign/req-2']);
    expect(rows()[0].textContent).toContain('Offer');
    expect(rows()[0].textContent).toContain('ZEN-8F3KQ2');
  });

  it('colours the status badge by outcome', () => {
    answer([
      request({ id: 'a', status: 'completed' }),
      request({ id: 'b', status: 'declined' }),
      request({ id: 'c', status: 'expired' }),
      request({ id: 'd', status: 'sent' }),
    ]);
    const badges = rows().map((row) => row.querySelector('a .badge')!);
    expect(badges.map((b) => b.textContent!.trim()))
      .toEqual(['completed', 'declined', 'expired', 'sent']);
    expect(badges[0].classList).toContain('badge-success');
    expect(badges[1].classList).toContain('badge-danger');
    expect(badges[2].classList).toContain('badge-warning');
    for (const cls of ['badge-success', 'badge-danger', 'badge-warning']) {
      expect(badges[3].classList).not.toContain(cls);
    }
  });

  it('shows a chip per recipient, named when a name is known', () => {
    answer([request({
      recipients: [
        recipient({ id: 'r1', name: 'Sam', email: 'sam@example.com', status: 'completed' }),
        recipient({ id: 'r2', name: '', email: 'pat@example.com', status: 'notified' }),
      ],
    })]);
    const chips = [...root().querySelectorAll('[data-test="recipient-chip"]')]
      .map((chip) => chip.textContent!.replace(/\s+/g, ' ').trim());
    expect(chips).toEqual(['Sam · completed', 'pat@example.com · notified']);
  });

  it('shows the empty state, not a spinner forever, when the list cannot be loaded', () => {
    http.expectOne('/api/sign-requests/')
      .flush({ error: { code: 'server_error', message: 'down' } }, { status: 500, statusText: 'Down' });
    fixture.detectChanges();
    expect(empty()).not.toBeNull();
    expect(rows()).toEqual([]);
  });
});
