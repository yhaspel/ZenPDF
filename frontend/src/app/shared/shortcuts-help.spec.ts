import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EDITOR_SHORTCUTS } from './shortcuts';
import { ShortcutsHelp } from './shortcuts-help';

describe('ShortcutsHelp', () => {
  let fixture: ComponentFixture<ShortcutsHelp>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ShortcutsHelp] });
    fixture = TestBed.createComponent(ShortcutsHelp);
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  function html(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('lists every shortcut the app implements', () => {
    const rows = html().querySelectorAll('[data-test=shortcut-row]');
    expect(rows.length).toBe(EDITOR_SHORTCUTS.length);
    const text = html().textContent ?? '';
    for (const spec of EDITOR_SHORTCUTS) {
      expect(text).toContain(spec.label);
    }
  });

  it('gives every key glyph the word a screen reader should say', () => {
    // A bare ⌘ is announced as "place of interest sign" and ⇧ as "upwards
    // white arrow" — neither of which is a key anyone can find.
    const keys = html().querySelectorAll('kbd');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of Array.from(keys)) {
      expect(key.getAttribute('aria-label')?.length).toBeGreaterThan(0);
    }
  });

  it('is a named modal dialog, not an anonymous div', () => {
    const dialog = html().querySelector('[data-test=shortcuts-help]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(html().querySelector(`#${labelledBy}`)?.textContent).toContain('Keyboard shortcuts');
  });

  it('makes the scrolling list reachable from the keyboard', () => {
    // `.modal` is a scroll container and Safari does not make scrollers
    // focusable, so inside a focus trap a long list would be unreachable.
    const region = html().querySelector('[role=region]')!;
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBe('Keyboard shortcuts');
  });

  it('closes on the button and on Escape', () => {
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));

    html().querySelector<HTMLButtonElement>('[data-test=shortcuts-close]')!.click();
    expect(closed).toBe(1);

    html().querySelector('[data-test=shortcuts-help]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(2);
  });
});
