import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastHost } from './toast-host';
import { ToastService } from './toast.service';

@Component({ imports: [ToastHost], template: '<app-toast-host />' })
class Host {}

/**
 * The live region (§10.3): a job finishing is announced, not only shown; an
 * error interrupts; and each toast is its own button so a click dismisses
 * exactly the one under the pointer.
 */
describe('ToastHost', () => {
  let fixture: ComponentFixture<Host>;
  let toasts: ToastService;

  function region(): HTMLElement {
    return fixture.nativeElement.querySelector('[data-test=toast-host]');
  }

  function rendered(): HTMLButtonElement[] {
    return [...region().querySelectorAll<HTMLButtonElement>('.toast')];
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    toasts = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('is a polite live region, present and empty before any toast', () => {
    expect(region().getAttribute('aria-live')).toBe('polite');
    // Atomic belongs on each toast, not here: on the container it would
    // re-announce the whole stack every time one arrives.
    expect(region().hasAttribute('aria-atomic')).toBe(false);
    expect(rendered()).toHaveLength(0);
  });

  it.each([
    ['success', 'status', 'toast-success'],
    ['info', 'status', null],
    ['error', 'alert', 'toast-error'],
  ] as const)('renders a %s toast as role=%s', (type, role, cssClass) => {
    toasts.show('Done', type);
    fixture.detectChanges();
    const [toast] = rendered();
    expect(toast.getAttribute('role')).toBe(role);
    expect(toast.getAttribute('data-test')).toBe(`toast-${type}`);
    expect(toast.getAttribute('aria-atomic')).toBe('true');
    expect(toast.textContent?.trim()).toBe('Done');
    expect(toast.getAttribute('aria-label')).toBe('Done — dismiss');
    if (cssClass) expect(toast.classList.contains(cssClass)).toBe(true);
    expect(toast.classList.contains('toast-success')).toBe(cssClass === 'toast-success');
    expect(toast.classList.contains('toast-error')).toBe(cssClass === 'toast-error');
  });

  it('stacks toasts in arrival order', () => {
    toasts.success('first');
    toasts.error('second');
    fixture.detectChanges();
    expect(rendered().map((t) => t.textContent?.trim())).toEqual(['first', 'second']);
  });

  it('dismisses the toast that was clicked and no other', () => {
    toasts.info('keep');
    toasts.info('drop');
    fixture.detectChanges();
    rendered()[1].click();
    fixture.detectChanges();
    expect(rendered().map((t) => t.textContent?.trim())).toEqual(['keep']);
  });

  it('removes a toast from the DOM when its time is up', () => {
    toasts.success('receipt');
    fixture.detectChanges();
    expect(rendered()).toHaveLength(1);
    vi.advanceTimersByTime(4500);
    fixture.detectChanges();
    expect(rendered()).toHaveLength(0);
  });
});
