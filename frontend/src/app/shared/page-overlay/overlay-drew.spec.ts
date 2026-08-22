import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { PageOverlay } from './page-overlay';

/**
 * `data-test=overlay-drew` — the editing modes' half of "the page actually
 * drew".
 *
 * Annotate, Edit, Forms, Protect and Sign never touch pdf.js; they draw an
 * `<img>` of the server-rendered page. `load` is not the event to trust for
 * that: a zero-byte or broken raster fires it too, and a guest marking up a
 * blank white box is the same defect as a viewer that renders nothing, one
 * screen over.
 */
describe('PageOverlay — the raster-drew marker', () => {
  function build() {
    TestBed.configureTestingModule({
      imports: [PageOverlay],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(PageOverlay);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('renderWidth', 600);
    fixture.detectChanges();
    return {
      fixture,
      inner: fixture.componentInstance as unknown as {
        imageUrl: { set(v: string | null): void };
        rasterDrawn(): boolean;
        onImageLoad(event: Event): void;
      },
    };
  }

  /** A `load` event from an image of the given natural size and src. */
  function loadEvent(src: string, naturalWidth: number, naturalHeight = 1400): Event {
    const img = {
      naturalWidth,
      naturalHeight,
      getAttribute: (name: string) => (name === 'src' ? src : null),
    };
    return { target: img } as unknown as Event;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('claims nothing before a raster has decoded', () => {
    const { inner } = build();
    inner.imageUrl.set('blob:page-1');
    expect(inner.rasterDrawn()).toBe(false);
  });

  it('refuses a raster that loaded with no natural size', () => {
    const { inner } = build();
    inner.imageUrl.set('blob:page-1');
    inner.onImageLoad(loadEvent('blob:page-1', 0, 0));
    expect(inner.rasterDrawn()).toBe(false);
  });

  it('claims the raster drew once it decodes with a real size', () => {
    const { inner } = build();
    inner.imageUrl.set('blob:page-1');
    inner.onImageLoad(loadEvent('blob:page-1', 1200));
    expect(inner.rasterDrawn()).toBe(true);
  });

  it('withdraws the claim when the page or the version changes the raster', () => {
    const { inner } = build();
    inner.imageUrl.set('blob:page-1');
    inner.onImageLoad(loadEvent('blob:page-1', 1200));
    expect(inner.rasterDrawn()).toBe(true);

    // Next page, or the same page of a new version: a fresh object URL that
    // nothing has decoded yet.
    inner.imageUrl.set('blob:page-2');
    expect(inner.rasterDrawn()).toBe(false);
  });
});
