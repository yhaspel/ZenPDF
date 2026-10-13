import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './empty-state';

@Component({
  imports: [EmptyState],
  template: '<app-empty-state [title]="title()" [subtitle]="subtitle()" />',
})
class Host {
  readonly title = input('Nothing here yet');
  readonly subtitle = input('');
}

function render(inputs: { title?: string; subtitle?: string } = {}): HTMLElement {
  const fixture = TestBed.createComponent(Host);
  if (inputs.title !== undefined) fixture.componentRef.setInput('title', inputs.title);
  if (inputs.subtitle !== undefined) fixture.componentRef.setInput('subtitle', inputs.subtitle);
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('[data-test=empty-state]') as HTMLElement;
}

/**
 * The folded sheet (design contract §3): a title, an optional subtitle, and
 * a decorative icon that a screen reader skips.
 */
describe('EmptyState', () => {
  it('renders the title it is given', () => {
    const el = render({ title: 'No documents yet' });
    expect(el.querySelector('.empty-title')?.textContent).toBe('No documents yet');
  });

  it('has a quiet default title', () => {
    expect(render().querySelector('.empty-title')?.textContent).toBe('Nothing here yet');
  });

  it('renders a subtitle only when there is one', () => {
    expect(render().querySelectorAll('p')).toHaveLength(1);

    const el = render({ subtitle: 'Upload a PDF to get started.' });
    const paragraphs = [...el.querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual(['Nothing here yet', 'Upload a PDF to get started.']);
  });

  it('hides the icon from assistive tech and uses no emoji', () => {
    const el = render();
    expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
