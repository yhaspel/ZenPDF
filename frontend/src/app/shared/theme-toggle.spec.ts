import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeService } from '../core/services/theme.service';
import { ThemeToggle } from './theme-toggle';

@Component({ imports: [ThemeToggle], template: '<app-theme-toggle />' })
class Host {}

/**
 * The header toggle (design contract §5): one 44 px button that cycles
 * Light → Dark → System, shows the current preference as its icon and says it
 * in its label. The glyphs are told apart by shape, which is what a test can
 * see: the sun has a circle, the moon is one path, the monitor has a rect.
 */
describe('ThemeToggle', () => {
  let fixture: ComponentFixture<Host>;
  let theme: ThemeService;

  function button(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('[data-test=theme-toggle]');
  }

  function glyph(): 'sun' | 'moon' | 'monitor' | 'none' {
    const svg = button().querySelector('svg');
    if (!svg) return 'none';
    if (svg.querySelector('circle')) return 'sun';
    if (svg.querySelector('rect')) return 'monitor';
    return 'moon';
  }

  beforeEach(() => {
    localStorage.clear();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    theme = TestBed.inject(ThemeService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('is a single labelled button showing the System glyph by default', () => {
    expect(button().type).toBe('button');
    expect(button().classList.contains('theme-toggle')).toBe(true);
    expect(button().getAttribute('aria-label')).toBe('Theme: System — change theme');
    expect(button().title).toBe('Theme: System — change theme');
    expect(glyph()).toBe('monitor');
    expect(button().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('cycles the preference on each click and persists it', () => {
    button().click();
    fixture.detectChanges();
    expect(theme.preference()).toBe('light');
    expect(localStorage.getItem('zenpdf.theme')).toBe('light');

    button().click();
    fixture.detectChanges();
    expect(theme.preference()).toBe('dark');

    button().click();
    fixture.detectChanges();
    expect(theme.preference()).toBe('system');
  });

  it.each([
    ['light', 'sun', 'Theme: Light — change theme'],
    ['dark', 'moon', 'Theme: Dark — change theme'],
    ['system', 'monitor', 'Theme: System — change theme'],
  ] as const)('shows the %s preference as the %s with its name in the label', (pref, expected, label) => {
    theme.set(pref);
    fixture.detectChanges();
    expect(glyph()).toBe(expected);
    expect(button().getAttribute('aria-label')).toBe(label);
  });
});
