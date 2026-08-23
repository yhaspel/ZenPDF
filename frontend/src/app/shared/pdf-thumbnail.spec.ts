import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Component, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsService } from '../core/services/documents.service';
import { ThumbnailScheduler } from '../core/services/thumbnail-scheduler';
import { PdfThumbnail } from './pdf-thumbnail';

@Component({
  imports: [PdfThumbnail],
  template: `
    @for (page of pages(); track page) {
      <app-pdf-thumbnail docId="doc-1" [page]="page" />
    }
  `,
})
class Host {
  readonly pages = input<number[]>([0]);
}

const PNG = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

/** A request that is simply still in flight. */
const PENDING = Symbol('pending');

/** A refusal shaped the way the API sends one. */
function refusal(status: number, retryAfter?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    headers: retryAfter ? new HttpHeaders({ 'Retry-After': retryAfter }) : undefined,
  });
}

/**
 * L9 — a failed tile and a loading tile looked identical, and then a rail of
 * 500 of them each discovered the throttle separately.
 *
 * The first half shipped in phase 10: a distinct failed state with a labelled
 * retry. The finding also asked for "backoff on transient statuses (esp. 429)",
 * and that did not — so 500 tiles answered 429 became 500 retry buttons a
 * person could mash, which is not a backoff (queue, 2026-08-04).
 */
describe('PdfThumbnail', () => {
  let calls: number[];
  let fixture: ComponentFixture<Host>;

  /** `answers` is consumed one per call; the last one repeats. */
  function configure(answers: (Blob | HttpErrorResponse | typeof PENDING)[]) {
    calls = [];
    TestBed.configureTestingModule({
      providers: [{
        provide: DocumentsService,
        useValue: {
          thumbnailBlob: (_id: string, page: number): Observable<Blob> => {
            const answer = answers[Math.min(calls.length, answers.length - 1)];
            calls.push(page);
            if (answer === PENDING) return new Observable<Blob>(() => { /* never */ });
            return answer instanceof HttpErrorResponse
              ? throwError(() => answer)
              : of(answer);
          },
        },
      }],
    });
  }

  function mount(pages = [0]): HTMLElement {
    // Root-provided and shared by the whole rail, so each case starts it clean.
    TestBed.inject(ThumbnailScheduler).reset();
    fixture = TestBed.createComponent(Host);
    fixture.componentRef.setInput('pages', pages);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  /** Let the backoff's timers fire, then re-render. */
  function advance(ms: number): void {
    vi.advanceTimersByTime(ms);
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Jitter exists so a paused rail does not resume on one millisecond; here
    // it would only make the assertions approximate.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  describe('backing off', () => {
    it('waits the window the server asked for, then succeeds', () => {
      configure([refusal(429, '2'), PNG()]);
      const html = mount();

      // Not failed — it is coming, just not yet. That distinction is the fix.
      expect(html.querySelector('[data-test=thumb-loading]')).toBeTruthy();
      expect(html.querySelector('[data-test=thumb-failed]')).toBeNull();
      expect(calls.length).toBe(1);

      advance(1_900);
      expect(calls.length).toBe(1);   // `Retry-After: 2` means two seconds

      advance(200);
      expect(calls.length).toBe(2);
      expect(html.querySelector('img')).toBeTruthy();
      expect(html.querySelector('[data-test=thumb-failed]')).toBeNull();
    });

    it('doubles its own wait when the server names no window', () => {
      configure([refusal(429), refusal(429), PNG()]);
      const html = mount();

      advance(1_000);                 // 1 s
      expect(calls.length).toBe(2);
      advance(1_000);
      expect(calls.length).toBe(2);   // …then 2 s, not another 1
      advance(1_000);
      expect(calls.length).toBe(3);
      expect(html.querySelector('img')).toBeTruthy();
    });

    it('gives up after four attempts and offers the retry', () => {
      configure([refusal(429, '2')]);
      const html = mount();

      advance(2_000);
      advance(2_000);
      advance(2_000);

      expect(calls.length).toBe(4);
      const button = html.querySelector('[data-test=thumb-failed]');
      expect(button).toBeTruthy();
      expect(button!.getAttribute('aria-label')).toContain('Retry');
      expect(html.querySelector('[data-test=thumb-loading]')).toBeNull();
    });

    it('does not argue with an answer — 404 fails at once', () => {
      configure([refusal(404)]);
      const html = mount();

      expect(calls.length).toBe(1);
      expect(html.querySelector('[data-test=thumb-failed]')).toBeTruthy();

      advance(30_000);
      expect(calls.length).toBe(1);
    });

    it('holds the rest of the rail while one tile waits the window out', () => {
      // One tile discovers the limit; the other 499 do not have to.
      configure([refusal(429, '5'), PNG()]);
      mount([0, 1, 2]);

      // Page 0 asked and was refused. Nobody else asks into a closed window.
      expect(calls).toEqual([0]);

      advance(4_900);
      expect(calls).toEqual([0]);

      advance(200);
      // The window opened: the refused tile asks again and the two that never
      // got to ask finally do.
      expect(calls.sort()).toEqual([0, 0, 1, 2]);
      expect(fixture.nativeElement.querySelectorAll('img').length).toBe(3);
    });

    it('costs an unthrottled rail nothing — no tile waits for a turn', () => {
      configure([PNG()]);
      const html = mount([0, 1, 2]);

      // Synchronously, in the first render: no scheduling tick in the way.
      expect(calls.length).toBe(3);
      expect(html.querySelectorAll('img').length).toBe(3);
      expect(TestBed.inject(ThumbnailScheduler).paused).toBe(false);
    });
  });

  describe('the states a person sees', () => {
    it('shows the loading placeholder, not the failure, while it is working', () => {
      configure([PENDING]);
      const html = mount();

      const loading = html.querySelector('[data-test=thumb-loading]');
      expect(loading).toBeTruthy();
      expect(html.querySelector('[data-test=thumb-failed]')).toBeNull();
      // Named, so the wait is not silent to a screen reader.
      expect(loading!.getAttribute('aria-label')).toBe('Loading preview of page 1');
    });

    it('asks again when the retry is clicked, and clears the state on success', () => {
      configure([refusal(404), PNG()]);
      const html = mount();

      expect(html.querySelector('[data-test=thumb-failed]')).toBeTruthy();
      html.querySelector<HTMLButtonElement>('[data-test=thumb-failed]')!.click();
      fixture.detectChanges();

      expect(calls.length).toBe(2);
      expect(html.querySelector('[data-test=thumb-failed]')).toBeNull();
      expect(html.querySelector('img')).toBeTruthy();
    });
  });
});
