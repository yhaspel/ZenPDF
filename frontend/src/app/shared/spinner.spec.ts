import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { Spinner } from './spinner';

@Component({ imports: [Spinner], template: '<app-spinner />' })
class Host {}

function render(): HTMLElement {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('[data-test=spinner]') as HTMLElement;
}

/**
 * The breath (design contract §3): a decorative circle whose motion lives
 * entirely in CSS, so reduced motion collapses it to a static dot without
 * the component knowing. The counting copy beside it carries progress, so the
 * dot itself says nothing to assistive tech.
 */
describe('Spinner', () => {
  it('is the breath dot, hidden from assistive tech', () => {
    const dot = render().querySelector('.breath-dot');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('animates in CSS only — no inline motion to survive reduced motion', () => {
    const el = render();
    expect(el.textContent?.trim()).toBe('');
    for (const node of [el, ...el.querySelectorAll<HTMLElement>('*')]) {
      expect(node.getAttribute('style')).toBeNull();
    }
  });
});
