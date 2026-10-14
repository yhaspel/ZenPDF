import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';

import { CeremonyMeta, SignFieldModel } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { Ceremony } from './ceremony';

/**
 * The signing ceremony (`/s/:token`, phase-08 §8B).
 *
 * The person on this screen has no account and did not choose to be here, so
 * every state it can land in has to be the right one: consent before anything
 * can be signed, the Finish button held back until every required field is
 * done, a closed request told apart from a broken link, and the download
 * links shown only once everyone has signed. Each of those is a thing the
 * template decides, and each is asserted through its `data-test` hook.
 */
describe('Ceremony', () => {
  let fixture: ComponentFixture<Ceremony>;
  let esign: {
    ceremony: ReturnType<typeof vi.fn>;
    disclosure: ReturnType<typeof vi.fn>;
    consent: ReturnType<typeof vi.fn>;
    fillField: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    decline: ReturnType<typeof vi.fn>;
    report: ReturnType<typeof vi.fn>;
    renderTyped: ReturnType<typeof vi.fn>;
    ceremonyContentUrl: (token: string) => string;
    ceremonyPageUrl: (token: string, page: number) => string;
    recipientDownloadUrl: (token: string, what: string) => string;
  };

  const TOKEN = 'tok-abc';

  const SIGNATURE: SignFieldModel = {
    id: 'f-sig', recipient_id: 'r1', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06,
    type: 'signature', required: true, label: '',
  };
  const NAME: SignFieldModel = {
    id: 'f-name', recipient_id: 'r1', page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.04,
    type: 'text', required: true, label: 'Full name',
  };
  const TICK: SignFieldModel = {
    id: 'f-tick', recipient_id: 'r1', page: 0, x: 0.5, y: 0.5, w: 0.05, h: 0.03,
    type: 'checkbox', required: false, label: 'I accept',
  };
  const DATE: SignFieldModel = {
    id: 'f-date', recipient_id: 'r1', page: 0, x: 0.5, y: 0.7, w: 0.2, h: 0.04,
    type: 'date_signed', required: true, label: '',
  };

  const META: CeremonyMeta = {
    title: 'Offer letter',
    message: 'Please sign by Friday.',
    envelope_code: 'ZEN-8F3KQ2',
    status: 'sent',
    expires_at: null,
    sender: { name: 'Dana', email: 'dana@example.com' },
    me: {
      name: 'Sam', email: 'sam@example.com', role: 'signer', status: 'notified',
      consented: true, needs_consent: true, my_turn: true,
    },
    page_count: 2,
    fields: [SIGNATURE, NAME, TICK, DATE],
    disclosure_version: '2026-08-01',
  };

  const DISCLOSURE = {
    version: '2026-08-01',
    text: 'By ticking the box you agree to sign electronically.\nSecond line, verbatim.',
    disclosure_sha256: 'c'.repeat(64),
  };

  /** A §6 failure, shaped the way `apiError` reads it. */
  function failure(status: number, message?: string, code?: string) {
    return throwError(() => ({ status, error: { error: { code, message } } }));
  }

  function render(
    meta: CeremonyMeta | null = META,
    overrides: Partial<typeof esign> = {},
  ): void {
    esign = {
      ceremony: vi.fn(() => (meta ? of(meta) : new Subject<CeremonyMeta>())),
      disclosure: vi.fn(() => of(DISCLOSURE)),
      consent: vi.fn(() => of({ consented: true })),
      fillField: vi.fn(() => of({ id: 'x', filled: true })),
      complete: vi.fn(() => of({ completed: true, next: 'r2' })),
      decline: vi.fn(() => of({ declined: true })),
      report: vi.fn(() => of({ reported: true, reports: 1, paused: false })),
      renderTyped: vi.fn(() => of(new Blob(['png'], { type: 'image/png' }))),
      ceremonyContentUrl: (token) => `/api/public/sign/${token}/content/`,
      ceremonyPageUrl: (token, page) => `/api/public/sign/${token}/pages/${page}/?w=900`,
      recipientDownloadUrl: (token, what) => `/api/public/sign/${token}/download/${what}/`,
      ...overrides,
    };
    TestBed.configureTestingModule({
      imports: [Ceremony],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: EsignService, useValue: esign },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ token: TOKEN }) } },
        },
      ],
    });
    fixture = TestBed.createComponent(Ceremony);
    fixture.detectChanges();
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(test: string) =>
    root().querySelector<T>(`[data-test="${test}"]`);
  const all = (test: string) => root().querySelectorAll(`[data-test="${test}"]`);
  const text = (test: string) => q(test)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  /** Everything rendered (screens, banners and dialogs) as one line. */
  const renderedText = () => root().textContent?.replace(/\s+/g, ' ') ?? '';
  const click = (test: string) => {
    const el = q<HTMLButtonElement>(test);
    expect(el, `no [data-test="${test}"] on screen`).not.toBeNull();
    el!.click();
    fixture.detectChanges();
  };

  function typeInto(test: string, value: string): void {
    const input = q<HTMLInputElement>(test)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function blur(test: string): void {
    q<HTMLInputElement>(test)!.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
  }

  function tick(test: string, checked: boolean): void {
    const box = q<HTMLInputElement>(test)!;
    box.checked = checked;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  // ------------------------------------------------------------------ //
  // Loading and which screen
  // ------------------------------------------------------------------ //
  describe('loading', () => {
    it('asks for the ceremony by the token in the URL and shows the loading state until it arrives', () => {
      render(null);
      expect(esign.ceremony).toHaveBeenCalledWith(TOKEN);
      expect(q('ceremony-loading')).not.toBeNull();
      expect(q('sign-screen')).toBeNull();
      expect(q('consent-screen')).toBeNull();
    });

    it('renders the signer\'s fields once the meta arrives, leaving the date field to the server', () => {
      render();
      expect(q('sign-screen')).not.toBeNull();
      expect(text('envelope-code')).toBe('ZEN-8F3KQ2');
      // Three cards: the date is stamped at completion, not asked for.
      expect(all('ceremony-field').length).toBe(3);
      expect(q('sign-f-sig')).not.toBeNull();
      expect(q('field-f-name')).not.toBeNull();
      expect(q('field-f-tick')).not.toBeNull();
      expect(q('field-f-date')).toBeNull();
    });

    it('opens the document link and the page image at the token\'s public URLs', () => {
      render();
      expect(q<HTMLAnchorElement>('read-document')!.getAttribute('href'))
        .toBe(`/api/public/sign/${TOKEN}/content/`);
      expect(q<HTMLImageElement>('ceremony-page-image')!.getAttribute('src'))
        .toBe(`/api/public/sign/${TOKEN}/pages/0/?w=900`);
    });

    it('shows the wait screen when it is not this person\'s turn', () => {
      render({ ...META, me: { ...META.me, my_turn: false } });
      expect(q('wait-screen')).not.toBeNull();
      expect(q('sign-screen')).toBeNull();
      expect(q('finish')).toBeNull();
    });

    it('shows the done screen, without downloads, when this person has signed but others have not', () => {
      render({ ...META, me: { ...META.me, status: 'completed' } });
      expect(q('done-screen')).not.toBeNull();
      expect(q('download-final')).toBeNull();
      expect(q('download-certificate')).toBeNull();
      expect(q('finalizing')).toBeNull();
      expect(text('done-screen')).toContain('waiting for the others');
    });

    it('offers both downloads once the whole request is completed', () => {
      render({ ...META, status: 'completed', me: { ...META.me, status: 'completed' } });
      expect(q<HTMLAnchorElement>('download-final')!.getAttribute('href'))
        .toBe(`/api/public/sign/${TOKEN}/download/final/`);
      expect(q<HTMLAnchorElement>('download-certificate')!.getAttribute('href'))
        .toBe(`/api/public/sign/${TOKEN}/download/certificate/`);
    });
  });

  describe('a link that does not open', () => {
    const renderFailing = (status: number, message?: string) =>
      render(null, { ceremony: vi.fn(() => failure(status, message)) });

    it('treats a 410 as a closed request and shows the server\'s own sentence', () => {
      renderFailing(410, 'This request has expired.');
      expect(q('closed-screen')).not.toBeNull();
      expect(q('error-screen')).toBeNull();
      expect(text('ceremony-error')).toBe('This request has expired.');
    });

    it('treats any other failure as a broken link', () => {
      renderFailing(404, 'No such token.');
      expect(q('error-screen')).not.toBeNull();
      expect(q('closed-screen')).toBeNull();
      expect(text('ceremony-error')).toBe('No such token.');
    });

    it('falls back to its own sentence when the server sent none', () => {
      // A 404 with no message: the link really is not valid. Not status 0, where
      // the request never reached the server and says nothing about the link.
      renderFailing(404);
      expect(q('error-screen')).not.toBeNull();
      expect(text('ceremony-error')).toBe('This link is not valid.');
    });
  });

  // ------------------------------------------------------------------ //
  // Consent
  // ------------------------------------------------------------------ //
  describe('consent', () => {
    const unconsented = (): CeremonyMeta =>
      ({ ...META, me: { ...META.me, consented: false, needs_consent: true } });

    it('shows the disclosure verbatim, with its version, before anything can be signed', () => {
      render(unconsented());
      expect(q('consent-screen')).not.toBeNull();
      expect(q('sign-screen')).toBeNull();
      expect(q('finish')).toBeNull();
      expect(q('disclosure')!.textContent).toBe(DISCLOSURE.text);
      expect(text('consent-screen')).toContain('This is version 2026-08-01 of our disclosure');
      expect(text('sender-message')).toContain('Please sign by Friday.');
    });

    it('keeps Continue disabled until the box is ticked', () => {
      render(unconsented());
      expect(q<HTMLButtonElement>('consent-continue')!.disabled).toBe(true);
      tick('agree', true);
      expect(q<HTMLButtonElement>('consent-continue')!.disabled).toBe(false);
      tick('agree', false);
      expect(q<HTMLButtonElement>('consent-continue')!.disabled).toBe(true);
    });

    it('records the consent and moves on to the fields', () => {
      render(unconsented());
      tick('agree', true);
      click('consent-continue');
      expect(esign.consent).toHaveBeenCalledWith(TOKEN);
      expect(q('sign-screen')).not.toBeNull();
      expect(q('consent-screen')).toBeNull();
    });

    it('stays on the consent screen and shows the reason when consent is refused', () => {
      render(unconsented());
      esign.consent.mockReturnValue(failure(409, 'Consent is already recorded.'));
      tick('agree', true);
      click('consent-continue');
      expect(q('consent-screen')).not.toBeNull();
      expect(text('ceremony-error')).toBe('Consent is already recorded.');
      // Not stuck in the busy state: the person may try again.
      expect(q<HTMLButtonElement>('consent-continue')!.disabled).toBe(false);
    });

    it('skips consent when it was given on an earlier visit', () => {
      render({ ...META, me: { ...META.me, consented: true, needs_consent: true } });
      expect(q('consent-screen')).toBeNull();
      expect(q('sign-screen')).not.toBeNull();
      expect(esign.consent).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ //
  // Required fields gate Finish
  // ------------------------------------------------------------------ //
  describe('finishing', () => {
    it('holds Finish back until every required field is done, counting only those', () => {
      render();
      // Two required (signature, name); the optional tick and the stamped date
      // are not counted, and the next one is the first undone, by list order.
      expect(text('progress')).toBe('0 of 2 field(s) done · next: Signature on page 1');
      expect(q<HTMLButtonElement>('finish')!.disabled).toBe(true);

      typeInto('field-f-name', 'Sam Signer');
      blur('field-f-name');
      expect(text('progress')).toBe('1 of 2 field(s) done · next: Signature on page 1');
      expect(q<HTMLButtonElement>('finish')!.disabled).toBe(true);
    });

    it('enables Finish when the server already holds every required value', async () => {
      render({
        ...META,
        fields: [{ ...SIGNATURE, filled: true }, { ...NAME, filled: true, value: 'Sam' }, TICK, DATE],
      });
      expect(text('progress')).toBe('2 of 2 field(s) done');
      expect(q<HTMLButtonElement>('finish')!.disabled).toBe(false);
      expect(q('field-done')).not.toBeNull();
      // `ngModel` writes the saved value into the box a microtask later.
      await fixture.whenStable();
      expect(q<HTMLInputElement>('field-f-name')!.value).toBe('Sam');
    });

    it('completes, then shows the done screen and keeps waiting for the others', () => {
      render({ ...META, fields: [{ ...SIGNATURE, filled: true }, TICK, DATE] });
      // The refetch after Finish now reports this recipient as completed.
      esign.ceremony.mockReturnValue(of({ ...META, me: { ...META.me, status: 'completed' } }));
      click('finish');
      expect(esign.complete).toHaveBeenCalledWith(TOKEN);
      expect(q('done-screen')).not.toBeNull();
      expect(q('finalizing')).toBeNull();
      expect(q('download-final')).toBeNull();
    });

    it('polls for the seal when this was the last signer, and shows the downloads once it lands', () => {
      vi.useFakeTimers();
      render({ ...META, fields: [{ ...SIGNATURE, filled: true }, TICK, DATE] });
      esign.complete.mockReturnValue(of({ completed: true, next: 'completed' }));
      const sealed: CeremonyMeta = {
        ...META, status: 'completed',
        me: { ...META.me, status: 'completed' },
        fields: [{ ...SIGNATURE, filled: true }, TICK, DATE],
      };
      // The refetch straight after Finish still says `sent` (sealing runs on a
      // worker); the poll a moment later finds it completed.
      esign.ceremony
        .mockReturnValueOnce(of({ ...META, me: { ...META.me, status: 'completed' } }))
        .mockReturnValueOnce(of(sealed));

      click('finish');
      expect(q('done-screen')).not.toBeNull();
      expect(q('finalizing')).not.toBeNull();
      expect(q('download-final')).toBeNull();

      vi.advanceTimersByTime(1500);
      fixture.detectChanges();
      expect(q('finalizing')).toBeNull();
      expect(q('download-final')).not.toBeNull();
      expect(q('download-certificate')).not.toBeNull();
    });

    it('surfaces a refused completion and leaves the person on the fields', () => {
      render({ ...META, fields: [{ ...SIGNATURE, filled: true }, TICK, DATE] });
      esign.complete.mockReturnValue(failure(400, 'A required field is empty.'));
      click('finish');
      expect(q('sign-screen')).not.toBeNull();
      expect(text('ceremony-error')).toBe('A required field is empty.');
      expect(q<HTMLButtonElement>('finish')!.disabled).toBe(false);
    });

    it('labels the primary action for an approver', () => {
      render({ ...META, me: { ...META.me, role: 'approver' } });
      expect(text('finish')).toBe('Approve');
    });
  });

  // ------------------------------------------------------------------ //
  // Text and checkbox fields
  // ------------------------------------------------------------------ //
  describe('text and checkbox fields', () => {
    it('sends a text value on blur, not per keystroke', () => {
      render();
      typeInto('field-f-name', 'S');
      typeInto('field-f-name', 'Sa');
      typeInto('field-f-name', 'Sam');
      expect(esign.fillField).not.toHaveBeenCalled();
      blur('field-f-name');
      expect(esign.fillField).toHaveBeenCalledTimes(1);
      expect(esign.fillField).toHaveBeenCalledWith(TOKEN, { field_id: 'f-name', value: 'Sam' });
    });

    it('does not resend an unchanged value, but does send a cleared one', () => {
      render({ ...META, fields: [{ ...NAME, filled: true, value: 'Sam' }, DATE] });
      blur('field-f-name');
      expect(esign.fillField).not.toHaveBeenCalled();

      esign.fillField.mockReturnValue(of({ id: 'f-name', filled: false }));
      typeInto('field-f-name', '');
      blur('field-f-name');
      expect(esign.fillField).toHaveBeenCalledWith(TOKEN, { field_id: 'f-name', value: '' });
    });

    it('a field typed and committed, then cleared, is no longer counted as done', () => {
      render({ ...META, fields: [NAME, DATE] });
      typeInto('field-f-name', 'Sam');
      blur('field-f-name');
      expect(text('progress')).toBe('1 of 1 field(s) done');
      expect(q<HTMLButtonElement>('finish')!.disabled).toBe(false);

      esign.fillField.mockReturnValue(of({ id: 'f-name', filled: false }));
      typeInto('field-f-name', '');
      blur('field-f-name');
      expect(text('progress')).toBe('0 of 1 field(s) done · next: Full name on page 2');
      expect(q<HTMLButtonElement>('finish')!.disabled).toBe(true);
    });

    it('saves a tick immediately, as a boolean', async () => {
      render();
      // `ngModel` writes each box's starting value a microtask after render;
      // let that land first, as it always does before a real click.
      await fixture.whenStable();
      tick('field-f-tick', true);
      expect(esign.fillField).toHaveBeenCalledWith(TOKEN, { field_id: 'f-tick', value: true });
      // Read the box once the model has written back, not straight after the
      // click set it.
      await fixture.whenStable();
      expect(q<HTMLInputElement>('field-f-tick')!.checked).toBe(true);
    });

    it('reports a save that did not reach the server', () => {
      render();
      esign.fillField.mockReturnValue(failure(0));
      tick('field-f-tick', true);
      expect(text('ceremony-error')).toBe('That did not save — check your connection.');
    });
  });

  // ------------------------------------------------------------------ //
  // Signature capture
  // ------------------------------------------------------------------ //
  describe('signature capture', () => {
    /** A context that accepts the pad's strokes and records nothing. */
    function stubCanvas(): void {
      const ctx = {
        lineCap: '', lineJoin: '', lineWidth: 0, strokeStyle: '',
        beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
        clearRect: vi.fn(),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
        .mockImplementation(() => 'data:image/png;base64,DRAWN');
    }

    function stroke(): void {
      const canvas = q<HTMLCanvasElement>('sig-canvas')!;
      canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 600, height: 200, right: 600, bottom: 200, x: 0, y: 0 }) as DOMRect;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 30, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      fixture.detectChanges();
    }

    afterEach(() => vi.restoreAllMocks());

    it('opens the pad from the field card and closes it on Cancel', () => {
      render();
      expect(q('ceremony-pad')).toBeNull();
      click('sign-f-sig');
      expect(q('ceremony-pad')).not.toBeNull();
      expect(q('ceremony-pad')!.querySelector('[role="dialog"]')!.getAttribute('aria-label'))
        .toBe('Your signature');
      click('pad-cancel');
      expect(q('ceremony-pad')).toBeNull();
      expect(esign.fillField).not.toHaveBeenCalled();
    });

    it('a drawn signature feeds the field as an image and marks it done', () => {
      stubCanvas();
      render();
      click('sign-f-sig');
      expect(q<HTMLButtonElement>('sig-use')!.disabled).toBe(true);
      stroke();
      expect(q<HTMLButtonElement>('sig-use')!.disabled).toBe(false);
      click('sig-use');

      expect(esign.fillField).toHaveBeenCalledWith(TOKEN, {
        field_id: 'f-sig', signature_image: 'data:image/png;base64,DRAWN',
      });
      expect(q('ceremony-pad')).toBeNull();
      expect(q('sign-f-sig')).toBeNull();
      expect(q('field-done')).not.toBeNull();
      expect(q('change-f-sig')).not.toBeNull();
      expect(text('progress')).toBe('1 of 2 field(s) done · next: Full name on page 2');
    });

    it('a typed signature is rendered by the server and feeds the field the same way', async () => {
      vi.useFakeTimers();
      render();
      click('sign-f-sig');
      click('sig-tab-type');
      typeInto('sig-text', 'Sam Signer');
      // The typed preview is debounced 250 ms, then read through a FileReader
      // whose load comes three queued tasks later. Fake time runs them all, in
      // order; a real sleep only raced them.
      await vi.runAllTimersAsync();
      fixture.detectChanges();

      expect(esign.renderTyped).toHaveBeenCalledWith('Sam Signer', 'caveat');
      expect(q('sig-preview')).not.toBeNull();
      click('sig-use');

      expect(esign.fillField).toHaveBeenCalledTimes(1);
      const [, body] = esign.fillField.mock.calls[0] as [string, { field_id: string; signature_image: string }];
      expect(body.field_id).toBe('f-sig');
      expect(body.signature_image.startsWith('data:image/png;base64,')).toBe(true);
      expect(q('change-f-sig')).not.toBeNull();
    });

    it('keeps the pad open when the image is refused', () => {
      stubCanvas();
      render();
      esign.fillField.mockReturnValue(failure(413, 'That image is too large.'));
      click('sign-f-sig');
      stroke();
      click('sig-use');
      expect(q('ceremony-pad')).not.toBeNull();
      // The refusal is rendered, but where is deliberately not pinned: today it
      // is the page banner, which the pad's scrim covers.
      expect(renderedText()).toContain('That image is too large.');
      expect(q('sign-f-sig')).not.toBeNull();
    });

    it('offers initials under their own name', () => {
      render({ ...META, fields: [{ ...SIGNATURE, id: 'f-ini', type: 'initials' }, DATE] });
      expect(text('sign-f-ini')).toBe('Add initials');
      click('sign-f-ini');
      expect(q('ceremony-pad')!.querySelector('[role="dialog"]')!.getAttribute('aria-label'))
        .toBe('Your initials');
    });
  });

  // ------------------------------------------------------------------ //
  // The page viewer and its boxes
  // ------------------------------------------------------------------ //
  describe('the page viewer', () => {
    it('places each field\'s box on its page as plain percentages', () => {
      render();
      // Page 1 (index 0): the signature, the tick and the date; the name is on page 2.
      expect(q('box-f-sig')).not.toBeNull();
      expect(q('box-f-tick')).not.toBeNull();
      expect(q('box-f-date')).not.toBeNull();
      expect(q('box-f-name')).toBeNull();
      const style = q('box-f-sig')!.style;
      expect(style.left).toBe('10%');
      expect(style.top).toBe('70%');
      expect(style.width).toBe('30%');
      expect(style.height).toBe('6%');
    });

    it('pages forward and back within the document, and jumps to a field\'s page', () => {
      render();
      expect(text('ceremony-page')).toBe('Page 1 / 2');
      expect(q<HTMLButtonElement>('ceremony-prev')!.disabled).toBe(true);
      click('ceremony-next');
      expect(text('ceremony-page')).toBe('Page 2 / 2');
      expect(q<HTMLButtonElement>('ceremony-next')!.disabled).toBe(true);
      expect(q('box-f-name')).not.toBeNull();
      expect(q<HTMLImageElement>('ceremony-page-image')!.getAttribute('src'))
        .toBe(`/api/public/sign/${TOKEN}/pages/1/?w=900`);
      click('ceremony-prev');
      expect(text('ceremony-page')).toBe('Page 1 / 2');
      click('goto-f-name');
      expect(text('ceremony-page')).toBe('Page 2 / 2');
    });

    it('a box behaves like its card: a signature opens the pad, a tick toggles, a date does nothing', () => {
      render();
      click('box-f-date');
      expect(esign.fillField).not.toHaveBeenCalled();
      expect(q('ceremony-pad')).toBeNull();

      click('box-f-tick');
      expect(esign.fillField).toHaveBeenCalledWith(TOKEN, { field_id: 'f-tick', value: true });
      click('box-f-tick');
      expect(esign.fillField).toHaveBeenLastCalledWith(TOKEN, { field_id: 'f-tick', value: false });

      click('box-f-sig');
      expect(q('ceremony-pad')).not.toBeNull();
    });

    it('marks a filled box with a tick instead of its label', () => {
      render({ ...META, fields: [{ ...SIGNATURE, filled: true }, TICK, DATE] });
      expect(text('box-f-sig')).toBe('✓');
      expect(q('box-f-sig')!.classList).toContain('cbox-done');
      expect(text('box-f-tick')).toBe('I accept');
      expect(q('box-f-tick')!.classList).not.toContain('cbox-done');
    });
  });

  // ------------------------------------------------------------------ //
  // Declining and reporting
  // ------------------------------------------------------------------ //
  describe('declining', () => {
    it('sends the reason and closes the ceremony', () => {
      render();
      expect(q('decline-dialog')).toBeNull();
      click('decline-open');
      expect(q('decline-dialog')).not.toBeNull();
      typeInto('decline-reason', 'Wrong amount.');
      click('decline-confirm');

      expect(esign.decline).toHaveBeenCalledWith(TOKEN, 'Wrong amount.');
      expect(q('decline-dialog')).toBeNull();
      expect(q('closed-screen')).not.toBeNull();
      expect(q('sign-screen')).toBeNull();
      // Where the confirmation sits is deliberately not pinned: today it is the
      // red banner, which the component otherwise keeps for failures.
      expect(renderedText()).toContain('You declined to sign. The sender has been told.');
    });

    it('can be declined from the consent screen too', () => {
      render({ ...META, me: { ...META.me, consented: false } });
      click('decline-open');
      click('decline-confirm');
      expect(esign.decline).toHaveBeenCalledWith(TOKEN, '');
      expect(q('closed-screen')).not.toBeNull();
    });

    it('keeps the dialog open when the decline is refused', () => {
      render();
      esign.decline.mockReturnValue(failure(409, 'This request is already closed.'));
      click('decline-open');
      click('decline-confirm');
      expect(q('decline-dialog')).not.toBeNull();
      expect(q('sign-screen')).not.toBeNull();
      // The refusal is rendered, but where is deliberately not pinned: today it
      // is the page banner, which this dialog covers. A failed report is shown
      // inside its own dialog for exactly that.
      expect(renderedText()).toContain('This request is already closed.');
    });
  });

  describe('reporting', () => {
    it('thanks the reporter in the green banner, never the red one', () => {
      render();
      click('report-open');
      expect(q('report-dialog')).not.toBeNull();
      typeInto('report-reason', 'I never asked for this.');
      click('report-send');

      expect(esign.report).toHaveBeenCalledWith(TOKEN, 'I never asked for this.');
      expect(q('report-dialog')).toBeNull();
      expect(text('ceremony-notice')).toBe('Thank you. We have recorded your report.');
      expect(q('ceremony-error')).toBeNull();
      // Reporting is not declining: the ceremony is still open.
      expect(q('sign-screen')).not.toBeNull();
    });

    it('says so when enough reports paused the request', () => {
      render();
      esign.report.mockReturnValue(of({ reported: true, reports: 3, paused: true }));
      click('report-open');
      click('report-send');
      expect(text('ceremony-notice'))
        .toBe('Thank you — this request has been paused and the sender told.');
    });

    it('shows a failed report inside the dialog, where it can be seen', () => {
      render();
      esign.report.mockReturnValue(failure(0));
      click('report-open');
      click('report-send');
      expect(q('report-dialog')).not.toBeNull();
      expect(text('report-error')).toBe('That did not send. Try again in a moment.');
      expect(q('ceremony-error')).toBeNull();
      expect(q('ceremony-notice')).toBeNull();
    });
  });
});
