import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { Brand } from './brand';

@Component({
  imports: [Brand],
  template: '<a class="brand"><app-brand [size]="size()" [wordmark]="wordmark()" /></a>',
})
class Host {
  readonly size = input(28);
  readonly wordmark = input(true);
}

function render(inputs: { size?: number; wordmark?: boolean } = {}): HTMLElement {
  const fixture = TestBed.createComponent(Host);
  if (inputs.size !== undefined) fixture.componentRef.setInput('size', inputs.size);
  if (inputs.wordmark !== undefined) fixture.componentRef.setInput('wordmark', inputs.wordmark);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/**
 * The seal (design contract §1): three sizes across the product, a wordmark
 * that compact bars drop, and colours that come from the token layer so the
 * mark holds in both modes. The emoji it replaced must not come back.
 */
describe('Brand', () => {
  it.each([
    ['header', 28],
    ['compact bar', 20],
    ['auth brand panel', 56],
  ])('sizes the seal for a %s at %ipx', (_where, size) => {
    const svg = render({ size }).querySelector<SVGElement>('svg.seal')!;
    expect(svg.style.width).toBe(`${size}px`);
    expect(svg.style.height).toBe(`${size}px`);
  });

  it('defaults to the header size with the wordmark', () => {
    const el = render();
    expect(el.querySelector<SVGElement>('svg.seal')!.style.width).toBe('28px');
    expect(el.querySelector('b')?.textContent).toBe('ZenPDF');
    expect(el.querySelector('b > i')?.textContent).toBe('PDF');
  });

  it('drops the wordmark when asked, keeping the seal', () => {
    const el = render({ wordmark: false });
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('svg.seal')).not.toBeNull();
  });

  it('paints from the token layer and hides from assistive tech', () => {
    const svg = render().querySelector('svg.seal')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('var(--color-accent)');
    expect(svg.querySelector('path')?.getAttribute('stroke')).toBe('var(--color-on-accent)');
  });

  it('carries no emoji', () => {
    expect(render().textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
