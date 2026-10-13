import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { TOOL_SLUGS } from '../core/tool-pages';
import { ToolIcon } from './tool-icon';

@Component({
  imports: [ToolIcon],
  template: '<app-tool-icon [slug]="slug()" />',
})
class Host {
  readonly slug = input.required<string>();
}

function render(slug: string): SVGElement {
  const fixture = TestBed.createComponent(Host);
  fixture.componentRef.setInput('slug', slug);
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('svg') as SVGElement;
}

/**
 * The icon grid is a design-contract invariant (§2): every tool on the
 * landing page gets its own glyph, drawn inline, hidden from assistive tech,
 * stroke-only except the one sanctioned fill. A new tool slug that falls
 * through to the fallback document would ship a landing tile with the wrong
 * picture — and nothing but this would notice.
 */
describe('ToolIcon', () => {
  const fallback = () => render('no-such-tool').innerHTML;

  it('draws the fallback document for a slug it does not know', () => {
    const svg = render('no-such-tool');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it.each(TOOL_SLUGS)('has a glyph of its own for %s', (slug) => {
    const svg = render(slug);
    expect(svg.children.length).toBeGreaterThan(0);
    expect(svg.innerHTML).not.toBe(fallback());
  });

  it('has a glyph for the reading mode, which no tool supplies', () => {
    const svg = render('view');
    expect(svg.querySelectorAll('path')).toHaveLength(3);
    expect(svg.innerHTML).not.toBe(fallback());
  });

  it('gives every tool a distinct glyph', () => {
    const drawings = TOOL_SLUGS.map((slug) => render(slug).innerHTML);
    expect(new Set(drawings).size).toBe(TOOL_SLUGS.length);
  });

  it('fills nothing except the redact bar', () => {
    for (const slug of TOOL_SLUGS) {
      const filled = [...render(slug).querySelectorAll('[fill]')];
      if (slug === 'redact-pdf') {
        expect(filled).toHaveLength(1);
        expect(filled[0].getAttribute('fill')).toBe('currentColor');
      } else {
        expect(filled).toHaveLength(0);
      }
    }
  });
});
