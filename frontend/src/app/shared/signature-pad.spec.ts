import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EsignService } from '../core/services/esign.service';
import { SIGNATURE_FONTS, SignaturePad } from './signature-pad';

@Component({
  imports: [SignaturePad],
  template: '<app-signature-pad (chosen)="chosen.push($event)" />',
})
class Host {
  readonly chosen: string[] = [];
}

/**
 * jsdom has no canvas. This is a 2D context that remembers what it was asked
 * to draw — which is the only thing the pad does with it — plus a
 * `toDataURL` that returns something recognisable.
 */
interface FakeContext {
  calls: string[];
  lineWidth: number;
  strokeStyle: string;
  lineCap: string;
  lineJoin: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

const FAKE_PNG = 'data:image/png;base64,ZmFrZS1wbmc=';

function installFakeCanvas(): { context: FakeContext; restore: () => void } {
  const context: FakeContext = {
    calls: [],
    lineWidth: 1,
    strokeStyle: '#000',
    lineCap: 'butt',
    lineJoin: 'miter',
    beginPath() { this.calls.push('beginPath'); },
    moveTo(x, y) { this.calls.push(`moveTo(${x},${y})`); },
    lineTo(x, y) { this.calls.push(`lineTo(${x},${y})`); },
    stroke() { this.calls.push('stroke'); },
    clearRect(x, y, w, h) { this.calls.push(`clearRect(${x},${y},${w},${h})`); },
  };
  const proto = HTMLCanvasElement.prototype;
  const original = { getContext: proto.getContext, toDataURL: proto.toDataURL, rect: proto.getBoundingClientRect };
  proto.getContext = (() => context) as unknown as typeof proto.getContext;
  proto.toDataURL = () => FAKE_PNG;
  // Laid out at half its backing size, so the scaling has something to do.
  proto.getBoundingClientRect = () => ({
    left: 10, top: 20, width: 300, height: 100, right: 310, bottom: 120, x: 10, y: 20, toJSON: () => ({}),
  }) as DOMRect;
  return {
    context,
    restore: () => {
      proto.getContext = original.getContext;
      proto.toDataURL = original.toDataURL;
      proto.getBoundingClientRect = original.rect;
    },
  };
}

/**
 * Draw, type or upload a signature, and emit a PNG data URL — storing
 * nothing (phase-08). Drawn ink has to be withheld until there is some;
 * typed names are rendered by the server, debounced, and never fetch a font
 * from Google.
 */
describe('SignaturePad', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let canvasFake: ReturnType<typeof installFakeCanvas>;
  let renderTyped: ReturnType<typeof vi.fn>;

  function el<T extends HTMLElement = HTMLElement>(test: string): T {
    return fixture.nativeElement.querySelector(`[data-test=${test}]`);
  }

  function pointer(type: string, clientX: number, clientY: number): void {
    el('sig-canvas').dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true }));
  }

  function draw(points: [number, number][]): void {
    const [first, ...rest] = points;
    pointer('pointerdown', first[0], first[1]);
    for (const [x, y] of rest) pointer('pointermove', x, y);
    pointer('pointerup', 0, 0);
    fixture.detectChanges();
  }

  function switchTo(tab: 'draw' | 'type' | 'upload'): void {
    el(`sig-tab-${tab}`).click();
    fixture.detectChanges();
  }

  function typeName(name: string): void {
    const input = el<HTMLInputElement>('sig-text');
    input.value = name;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  /** Let the debounce fire, then the FileReader's queued tasks. */
  async function settle(): Promise<void> {
    await vi.runAllTimersAsync();
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    canvasFake = installFakeCanvas();
    renderTyped = vi.fn(() => of(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })));
    TestBed.configureTestingModule({
      providers: [{ provide: EsignService, useValue: { renderTyped } }],
    });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    host = fixture.componentInstance;
  });

  afterEach(() => {
    canvasFake.restore();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('opens on Draw with the three ways in, and withholds the signature until there is ink', () => {
    expect(el('sig-tab-draw').getAttribute('aria-pressed')).toBe('true');
    expect(el('sig-tab-type').getAttribute('aria-pressed')).toBe('false');
    expect(el('sig-canvas')).not.toBeNull();
    expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);

    el('sig-use').click();
    expect(host.chosen).toEqual([]);
  });

  describe('draw', () => {
    it('strokes between successive pointer positions, scaled to the backing size', () => {
      draw([[10, 20], [40, 30], [70, 70]]);
      // 300 css px wide for 600 backing px: every coordinate is doubled.
      expect(canvasFake.context.calls).toEqual([
        'beginPath', 'moveTo(0,0)', 'lineTo(60,20)', 'stroke',
        'beginPath', 'moveTo(60,20)', 'lineTo(120,100)', 'stroke',
      ]);
    });

    it('inks in the contract stroke, round-capped', () => {
      draw([[10, 20], [40, 30]]);
      expect(canvasFake.context.strokeStyle).toBe('#332D24');
      expect(canvasFake.context.lineWidth).toBe(2.6);
      expect(canvasFake.context.lineCap).toBe('round');
      expect(canvasFake.context.lineJoin).toBe('round');
    });

    it('does not draw from a hover — only while the pointer is down', () => {
      pointer('pointermove', 50, 50);
      pointer('pointermove', 80, 80);
      fixture.detectChanges();
      expect(canvasFake.context.calls).toEqual([]);
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
    });

    it('stops drawing once the pointer lifts, and again when it leaves the paper', () => {
      draw([[10, 20], [40, 30]]);
      pointer('pointermove', 90, 90);
      expect(canvasFake.context.calls).toHaveLength(4);

      pointer('pointerdown', 10, 20);
      el('sig-canvas').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      pointer('pointermove', 90, 90);
      expect(canvasFake.context.calls).toHaveLength(4);
    });

    it('a tap with no movement leaves no ink and nothing to use', () => {
      draw([[10, 20]]);
      expect(canvasFake.context.calls).toEqual([]);
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
    });

    it('emits the canvas as a PNG data URL once there is ink', () => {
      draw([[10, 20], [40, 30]]);
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(false);
      el('sig-use').click();
      expect(host.chosen).toEqual([FAKE_PNG]);
    });

    it('clears the paper and withholds the signature again', () => {
      draw([[10, 20], [40, 30]]);
      el('sig-clear').click();
      fixture.detectChanges();
      expect(canvasFake.context.calls.at(-1)).toBe('clearRect(0,0,600,200)');
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
      el('sig-use').click();
      expect(host.chosen).toEqual([]);
    });
  });

  describe('type', () => {
    it('offers the four vendored fonts, Caveat first', () => {
      switchTo('type');
      const buttons = [...fixture.nativeElement.querySelectorAll('[data-test^=sig-font-]')] as HTMLElement[];
      expect(buttons.map((b) => b.getAttribute('data-test'))).toEqual(
        SIGNATURE_FONTS.map((f) => `sig-font-${f.value}`),
      );
      expect(el('sig-font-caveat').getAttribute('aria-pressed')).toBe('true');
    });

    it('asks the server to render the name, once the typing pauses', async () => {
      switchTo('type');
      typeName('A');
      typeName('An');
      typeName('Ana');
      vi.advanceTimersByTime(249);
      expect(renderTyped).not.toHaveBeenCalled();

      await settle();
      expect(renderTyped).toHaveBeenCalledTimes(1);
      expect(renderTyped).toHaveBeenCalledWith('Ana', 'caveat');
      const preview = el<HTMLImageElement>('sig-preview');
      expect(preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(false);
    });

    it('emits the rendered preview, not the raw text', async () => {
      switchTo('type');
      typeName('Ana');
      await settle();
      el('sig-use').click();
      expect(host.chosen).toEqual([el<HTMLImageElement>('sig-preview').getAttribute('src')]);
    });

    it('re-renders in the chosen font', async () => {
      switchTo('type');
      typeName('Ana');
      await settle();
      el('sig-font-sacramento').click();
      fixture.detectChanges();
      await settle();
      expect(el('sig-font-sacramento').getAttribute('aria-pressed')).toBe('true');
      expect(renderTyped).toHaveBeenLastCalledWith('Ana', 'sacramento');
    });

    it('renders nothing for a blank name, and withholds the signature', async () => {
      switchTo('type');
      typeName('   ');
      await settle();
      expect(renderTyped).not.toHaveBeenCalled();
      expect(el('sig-preview')).toBeNull();
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
    });

    it('drops the preview when the render fails', async () => {
      switchTo('type');
      typeName('Ana');
      await settle();
      expect(el('sig-preview')).not.toBeNull();

      renderTyped.mockReturnValueOnce(throwError(() => new Error('503')));
      typeName('Anam');
      await settle();
      expect(el('sig-preview')).toBeNull();
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
    });

    it('clears the name and the preview together', async () => {
      switchTo('type');
      typeName('Ana');
      await settle();
      el('sig-clear').click();
      fixture.detectChanges();
      expect(el<HTMLInputElement>('sig-text').value).toBe('');
      expect(el('sig-preview')).toBeNull();
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
    });
  });

  describe('upload', () => {
    it('previews a chosen image and emits it as a data URL', async () => {
      switchTo('upload');
      const input = el<HTMLInputElement>('sig-file');
      expect(input.getAttribute('accept')).toBe('image/png,image/jpeg');
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);

      const file = new File([new Uint8Array([255, 216, 255])], 'sig.jpg', { type: 'image/jpeg' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
      await settle();

      const src = el<HTMLImageElement>('sig-preview').getAttribute('src');
      expect(src).toMatch(/^data:image\/jpeg;base64,/);
      el('sig-use').click();
      expect(host.chosen).toEqual([src]);
    });

    it('does nothing when the picker is cancelled', async () => {
      switchTo('upload');
      const input = el<HTMLInputElement>('sig-file');
      Object.defineProperty(input, 'files', { value: [], configurable: true });
      input.dispatchEvent(new Event('change'));
      await settle();
      expect(el('sig-preview')).toBeNull();
      expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
    });
  });

  it('judges "has ink" by the mode that is showing', async () => {
    draw([[10, 20], [40, 30]]);
    expect(el<HTMLButtonElement>('sig-use').disabled).toBe(false);

    // Drawn ink is not a typed preview: switching modes withholds again.
    switchTo('type');
    expect(el<HTMLButtonElement>('sig-use').disabled).toBe(true);
    typeName('Ana');
    await settle();
    expect(el<HTMLButtonElement>('sig-use').disabled).toBe(false);
  });
});
