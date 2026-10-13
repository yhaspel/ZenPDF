import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { VerifyReport } from '../../core/models/models';
import { Verify } from './verify';

/**
 * `/verify` (phase-08 §8C): the page that tells a stranger whether to believe
 * a PDF. It leads with what is true — intact, changed, or simply unsigned —
 * and says what it does *not* prove: a self-signed certificate must never
 * come back as a green tick.
 */
describe('Verify', () => {
  let fixture: ComponentFixture<Verify>;
  let http: HttpTestingController;

  const SEALED: VerifyReport = {
    sealed: true,
    integrity: 'intact',
    signatures: [{
      field: 'Sig1', signer: 'ZenPDF', intact: true, valid: true, coverage: 'whole',
      whole_document: true, signing_time: '2026-08-23T10:00:00Z', timestamp: false,
      trusted: false, reason: 'Sealed by ZenPDF',
    }],
    envelope_match: {
      found_code: 'ZEN-8F3KQ2', known: true, sha256_match: true,
      completed_at: '2026-08-23T10:00:00Z',
      signers: [{ name: 'Sam', email: 's***@example.com', role: 'signer', completed_at: null }],
    },
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Verify],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Verify);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(test: string) =>
    root().querySelector<T>(`[data-test="${test}"]`);
  const text = (test: string) => q(test)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  function choose(file: File): void {
    const input = q<HTMLInputElement>('verify-input')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function drop(file: File): void {
    const event = new Event('drop', { cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    q('verify-dropzone')!.dispatchEvent(event);
    fixture.detectChanges();
  }

  /** Answer the one in-flight verification. */
  function answer(report: VerifyReport | null, status = 200, message = ''): void {
    const req = http.expectOne('/api/verify/');
    expect(req.request.method).toBe('POST');
    if (report) {
      req.flush(report);
    } else {
      req.flush({ error: { code: 'invalid', message } }, { status, statusText: 'Bad' });
    }
    fixture.detectChanges();
  }

  const pdf = (name = 'signed.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

  it('shows nothing but the dropzone until a file is chosen', () => {
    expect(q('verify-dropzone')).not.toBeNull();
    expect(q('verify-report')).toBeNull();
    expect(q('verify-busy')).toBeNull();
    expect(q('verify-error')).toBeNull();
    http.expectNone('/api/verify/');
  });

  it('posts the chosen file as multipart and shows the file name while checking', () => {
    choose(pdf('offer.pdf'));
    expect(q('verify-busy')).not.toBeNull();
    expect(text('verify-dropzone')).toContain('offer.pdf');

    const req = http.expectOne('/api/verify/');
    expect(req.request.body instanceof FormData).toBe(true);
    expect((req.request.body as FormData).get('file')).toBeInstanceOf(File);
    expect(((req.request.body as FormData).get('file') as File).name).toBe('offer.pdf');
    req.flush(SEALED);
    fixture.detectChanges();
    expect(q('verify-busy')).toBeNull();
  });

  it('accepts a dropped file the same way', () => {
    drop(pdf('dropped.pdf'));
    const req = http.expectOne('/api/verify/');
    expect(((req.request.body as FormData).get('file') as File).name).toBe('dropped.pdf');
    req.flush(SEALED);
  });

  it('a change event with no file sends nothing', () => {
    const input = q<HTMLInputElement>('verify-input')!;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    http.expectNone('/api/verify/');
    expect(q('verify-busy')).toBeNull();
  });

  it('a ZenPDF envelope that matches is the best answer, and the self-signed cert is still named', () => {
    choose(pdf());
    answer(SEALED);

    expect(text('verify-headline')).toBe('Signed through ZenPDF, and unchanged since');
    expect(q('verify-report')!.classList).toContain('bg-success-surface');
    expect(text('envelope-match')).toContain('Envelope ZEN-8F3KQ2');
    expect(text('envelope-match')).toContain('fingerprint matches the one we recorded');
    expect(text('envelope-match')).toContain('Sam — signer');
    // Our dev certificate is self-signed; a green tick for it is a lie.
    expect(text('trust-line')).toContain('not from a trusted authority');
  });

  it('an intact seal from an unknown envelope is intact, no more', () => {
    choose(pdf());
    answer({
      ...SEALED,
      envelope_match: { found_code: 'ZEN-XXXXXX', known: false, sha256_match: false },
    });
    expect(text('verify-headline')).toBe('The signature is intact');
    expect(text('envelope-match')).toContain('We have no record of that envelope');
  });

  it('a modified document is a red card, whatever the envelope says', () => {
    choose(pdf());
    answer({ ...SEALED, integrity: 'modified' });
    expect(text('verify-headline')).toBe('This document has been changed');
    expect(q('verify-report')!.classList).toContain('bg-danger-surface');
    expect(text('verify-report')).toContain('Ask the sender for a fresh copy');
  });

  it('an unsigned PDF is neutral: not a fault, and nothing to show about it', () => {
    choose(pdf());
    answer({
      sealed: false, integrity: 'unsigned', signatures: [],
      envelope_match: { found_code: null, known: false, sha256_match: false },
    });
    expect(text('verify-headline')).toBe('This PDF has no signature');
    expect(q('verify-report')!.classList).toContain('bg-surface-raised');
    expect(q('verify-report')!.classList).not.toContain('bg-danger-surface');
    expect(q('signature-detail')).toBeNull();
    expect(q('envelope-match')).toBeNull();
  });

  it('shows the server\'s reason when the file is refused, and keeps the dropzone', () => {
    choose(pdf('huge.pdf'));
    answer(null, 413, 'That file is larger than 50 MB.');
    expect(text('verify-error')).toBe('That file is larger than 50 MB.');
    expect(q('verify-report')).toBeNull();
    expect(q('verify-busy')).toBeNull();
    expect(q('verify-dropzone')).not.toBeNull();
  });

  it('falls back to its own sentence when the failure carried none', () => {
    choose(pdf('corrupt.pdf'));
    http.expectOne('/api/verify/').error(new ProgressEvent('error'), { status: 0 });
    fixture.detectChanges();
    expect(text('verify-error')).toBe('That file could not be checked.');
  });

  it('clears the last answer when a second file is checked', () => {
    choose(pdf('one.pdf'));
    answer(null, 400, 'Not a PDF.');
    expect(q('verify-error')).not.toBeNull();

    choose(pdf('two.pdf'));
    expect(q('verify-error')).toBeNull();
    expect(q('verify-busy')).not.toBeNull();
    answer(SEALED);
    expect(q('verify-report')).not.toBeNull();

    choose(pdf('three.pdf'));
    expect(q('verify-report')).toBeNull();
    answer(SEALED);
  });
});
