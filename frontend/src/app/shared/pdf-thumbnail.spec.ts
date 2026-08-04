import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';

import { DocumentsService } from '../core/services/documents.service';
import { PdfThumbnail } from './pdf-thumbnail';

@Component({
  imports: [PdfThumbnail],
  template: '<app-pdf-thumbnail docId="doc-1" [page]="0" />',
})
class Host {}

/**
 * L9 — a failed tile and a loading tile looked identical.
 *
 * Both fell through to the `…` placeholder, so a rail that had run into the
 * 429 its own lazy-loading comment warns about sat there apparently still
 * working, for ever, with nothing to click.
 */
describe('PdfThumbnail failure state', () => {
  function configure(thumbnailBlob: () => Observable<Blob>) {
    TestBed.configureTestingModule({
      providers: [{ provide: DocumentsService, useValue: { thumbnailBlob } }],
    });
  }

  afterEach(() => TestBed.resetTestingModule());

  it('offers a retry when the fetch fails', () => {
    configure(() => throwError(() => ({ status: 429 })));
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const html: HTMLElement = fixture.nativeElement;
    expect(html.querySelector('[data-test=thumb-failed]')).toBeTruthy();
    expect(html.querySelector('[data-test=thumb-loading]')).toBeNull();
    // Named for a screen reader, not just drawn.
    expect(
      html.querySelector('[data-test=thumb-failed]')?.getAttribute('aria-label'),
    ).toContain('Retry');
  });

  it('asks again when the retry is clicked, and clears the state on success', () => {
    let calls = 0;
    configure(() => {
      calls += 1;
      return calls === 1
        ? throwError(() => ({ status: 429 }))
        : of(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const html: HTMLElement = fixture.nativeElement;
    html.querySelector<HTMLButtonElement>('[data-test=thumb-failed]')!.click();
    fixture.detectChanges();

    expect(calls).toBe(2);
    expect(html.querySelector('[data-test=thumb-failed]')).toBeNull();
    expect(html.querySelector('img')).toBeTruthy();
  });

  it('shows the loading placeholder, not the failure, while it is working', () => {
    configure(() => new Observable<Blob>(() => { /* never emits */ }));
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const html: HTMLElement = fixture.nativeElement;
    expect(html.querySelector('[data-test=thumb-loading]')).toBeTruthy();
    expect(html.querySelector('[data-test=thumb-failed]')).toBeNull();
  });
});
