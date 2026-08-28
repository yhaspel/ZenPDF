import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { OverlayDraft } from '../../shared/page-overlay/overlay-model';
import { Annotate } from './annotate';

/**
 * The Tick box tool (2026-08-28): one click places a checkmark, a dash or a
 * cross over a printed form's checkbox.
 *
 * The marks are plain ink strokes — nothing new exists server-side, and the
 * placed mark selects, drags, copies and deletes like any other drawing. What
 * is worth pinning here is the geometry (a 14 pt square that is square *on
 * paper*, centred on the click, kept on the page at the edges), the default
 * (checkmark), and the bar's selector existing exactly while the tool is
 * armed.
 */
describe('Annotate — the Tick box tool', () => {
  let fixture: ComponentFixture<Annotate>;
  let annotations: AnnotationsFacade;

  /** Reach the protected API the template binds to. */
  const api = () => fixture.componentInstance as unknown as {
    tool(): string;
    setTool(t: string): void;
    tickMark: { (): string; set(v: string): void };
    onCreated(draft: OverlayDraft): void;
    undo(): void;
  };

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  /** What the overlay's point gesture reports for a click at (x, y). */
  const clickAt = (x: number, y: number, page = 0): OverlayDraft => ({
    shape: 'point',
    page,
    rect: { x, y, w: 0.02, h: 0.02 },
  });

  // The facade's A4 defaults — no page-size payload arrives in these tests.
  const W = 14 / 595;
  const H = 14 / 842;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Annotate],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    annotations = TestBed.inject(AnnotationsFacade);
    annotations.clear();

    fixture = TestBed.createComponent(Annotate);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('pageCount', 3);
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('is in the palette, and the bar shows the marks only while it is armed', () => {
    const entry = el().querySelector<HTMLButtonElement>('[data-test=tool-tick]');
    expect(entry).not.toBeNull();
    expect(entry!.getAttribute('aria-pressed')).toBe('false');
    // Not armed → no selector: it answers a question only this tool asks.
    expect(el().querySelector('[data-test=tick-marks]')).toBeNull();

    entry!.click();
    fixture.detectChanges();
    expect(entry!.getAttribute('aria-pressed')).toBe('true');
    expect(el().querySelector('[data-test=tick-marks]')).not.toBeNull();

    api().setTool('select');
    fixture.detectChanges();
    expect(el().querySelector('[data-test=tick-marks]')).toBeNull();
  });

  it('defaults to the checkmark — one stroke of three points', () => {
    api().setTool('tick');
    fixture.detectChanges();
    expect(
      el().querySelector('[data-test=tick-mark-check]')!.getAttribute('aria-pressed'),
    ).toBe('true');

    api().onCreated(clickAt(0.5, 0.5));
    const all = annotations.all();
    expect(all.length).toBe(1);
    expect(all[0].type).toBe('ink');
    expect(all[0].ink!.length).toBe(1);
    expect(all[0].ink![0].length).toBe(3);
  });

  it('the dash is one two-point stroke, the cross two strokes', () => {
    api().setTool('tick');
    api().tickMark.set('dash');
    api().onCreated(clickAt(0.3, 0.3));
    api().tickMark.set('cross');
    api().onCreated(clickAt(0.6, 0.6));

    const [dash, cross] = annotations.all();
    expect(dash.ink!.length).toBe(1);
    expect(dash.ink![0].length).toBe(2);
    expect(cross.ink!.length).toBe(2);
    expect(cross.ink![0].length).toBe(2);
    expect(cross.ink![1].length).toBe(2);
  });

  it('places a 14 pt square centred on the click — square on paper, not on screen', () => {
    api().setTool('tick');
    api().onCreated(clickAt(0.5, 0.5));

    // The mark's box: x ∈ [0.5 − W/2, 0.5 + W/2], y likewise with H — W ≠ H
    // in page fractions precisely because the square is square in points.
    const boxX = 0.5 - W / 2;
    const boxY = 0.5 - H / 2;
    const [p0, p1, p2] = annotations.all()[0].ink![0];
    expect(p0[0]).toBeCloseTo(boxX + 0.1 * W, 5);
    expect(p0[1]).toBeCloseTo(boxY + 0.55 * H, 5);
    expect(p1[0]).toBeCloseTo(boxX + 0.4 * W, 5);
    expect(p1[1]).toBeCloseTo(boxY + 0.9 * H, 5);
    expect(p2[0]).toBeCloseTo(boxX + 0.9 * W, 5);
    expect(p2[1]).toBeCloseTo(boxY + 0.1 * H, 5);
  });

  it('keeps the whole mark on the page when the click is at the corner', () => {
    api().setTool('tick');
    api().tickMark.set('cross');
    api().onCreated(clickAt(0.999, 0.999));

    const points = annotations.all()[0].ink!.flat();
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(1 - W);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(1 - H);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it('takes the ink family’s colour, width and opacity', () => {
    api().setTool('tick');
    api().onCreated(clickAt(0.4, 0.4));
    const mark = annotations.all()[0];
    expect(mark.color).toBe('#332D24');
    expect(mark.width).toBe(2);
    expect(mark.opacity).toBe(1);
  });

  it('stays armed after placing a mark — ticking a form is click, click, click', () => {
    api().setTool('tick');
    api().onCreated(clickAt(0.2, 0.2));
    expect(api().tool()).toBe('tick');
    api().onCreated(clickAt(0.4, 0.2));
    expect(annotations.all().length).toBe(2);
  });

  it('one undo takes back one mark', () => {
    api().setTool('tick');
    api().onCreated(clickAt(0.2, 0.2));
    api().onCreated(clickAt(0.4, 0.2));
    api().undo();
    expect(annotations.all().length).toBe(1);
  });

  it('remembers the chosen mark across tool switches, in this session', () => {
    api().setTool('tick');
    api().tickMark.set('cross');
    api().setTool('select');
    api().setTool('tick');
    fixture.detectChanges();
    expect(
      el().querySelector('[data-test=tick-mark-cross]')!.getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
