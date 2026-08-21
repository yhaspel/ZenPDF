import {
  EDITOR_SHORTCUTS,
  NUDGE_VECTORS,
  ShortcutId,
  isTypingTarget,
  keyLabel,
  resolveShortcut,
  shortcutTitle,
} from './shortcuts';

/** A keydown as it would arrive, with a `target` we control. */
function press(
  key: string,
  init: Partial<KeyboardEventInit> & { target?: EventTarget } = {},
): KeyboardEvent {
  const { target, ...rest } = init;
  const event = new KeyboardEvent('keydown', { key, ...rest });
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
}

function field(tag: string): HTMLElement {
  return document.createElement(tag);
}

describe('resolveShortcut', () => {
  describe('the table', () => {
    it('resolves every editing binding on both modifiers', () => {
      for (const meta of [true, false]) {
        const mods = meta ? { metaKey: true } : { ctrlKey: true };
        expect(resolveShortcut(press('z', mods))).toBe('undo');
        expect(resolveShortcut(press('z', { ...mods, shiftKey: true }))).toBe('redo');
        expect(resolveShortcut(press('c', mods))).toBe('copy');
        expect(resolveShortcut(press('x', mods))).toBe('cut');
        expect(resolveShortcut(press('v', mods))).toBe('paste');
        expect(resolveShortcut(press('d', mods))).toBe('duplicate');
        expect(resolveShortcut(press('s', mods))).toBe('save');
        expect(resolveShortcut(press('/', mods))).toBe('help');
      }
    });

    it('resolves the keys that carry no modifier', () => {
      expect(resolveShortcut(press('Delete'))).toBe('delete');
      expect(resolveShortcut(press('Backspace'))).toBe('delete');
      expect(resolveShortcut(press('Escape'))).toBe('cancel');
      expect(resolveShortcut(press('ArrowUp'))).toBe('nudge-up');
      expect(resolveShortcut(press('ArrowDown'))).toBe('nudge-down');
      expect(resolveShortcut(press('ArrowLeft'))).toBe('nudge-left');
      expect(resolveShortcut(press('ArrowRight'))).toBe('nudge-right');
      expect(resolveShortcut(press('F10', { shiftKey: true }))).toBe('context-menu');
      expect(resolveShortcut(press('ContextMenu'))).toBe('context-menu');
    });

    it('takes Ctrl+Y as redo but leaves ⌘Y to the browser', () => {
      expect(resolveShortcut(press('y', { ctrlKey: true }))).toBe('redo');
      expect(resolveShortcut(press('y', { metaKey: true }))).toBeNull();
    });

    it('is case-insensitive, so Caps Lock is not a broken keyboard', () => {
      expect(resolveShortcut(press('Z', { metaKey: true }))).toBe('undo');
      expect(resolveShortcut(press('V', { ctrlKey: true }))).toBe('paste');
    });

    it('claims nothing it has not been given', () => {
      expect(resolveShortcut(press('q', { metaKey: true }))).toBeNull();
      expect(resolveShortcut(press('Enter'))).toBeNull();
      expect(resolveShortcut(press('a'))).toBeNull();
    });
  });

  describe('keeping out of the way', () => {
    it('resolves nothing but Escape while a field has focus', () => {
      for (const tag of ['input', 'textarea', 'select']) {
        const target = field(tag);
        expect(resolveShortcut(press('z', { metaKey: true, target }))).toBeNull();
        expect(resolveShortcut(press('Backspace', { target }))).toBeNull();
        expect(resolveShortcut(press('ArrowLeft', { target }))).toBeNull();
        // Escape survives: someone in a text box may well want out of it.
        expect(resolveShortcut(press('Escape', { target }))).toBe('cancel');
      }
    });

    it('treats a contenteditable the same as a text field', () => {
      const target = field('div');
      target.contentEditable = 'true';
      Object.defineProperty(target, 'isContentEditable', { value: true });
      expect(resolveShortcut(press('v', { metaKey: true, target }))).toBeNull();
    });

    it('leaves ⌘C and ⌘X alone when there is text selected to copy', () => {
      expect(resolveShortcut(press('c', { metaKey: true }), { hasTextSelection: true })).toBeNull();
      expect(resolveShortcut(press('x', { metaKey: true }), { hasTextSelection: true })).toBeNull();
      // …but paste is still ours: there is nothing to paste *into* a selection
      // out here on the page.
      expect(resolveShortcut(press('v', { metaKey: true }), { hasTextSelection: true }))
        .toBe('paste');
    });

    it('ignores Alt on its own, but not AltGr', () => {
      // Windows reports AltGr as ctrl+alt, and on German, Nordic, Polish and
      // Czech layouts `/` is an AltGr composition — vetoing every alt event
      // would put the shortcuts sheet out of reach on those keyboards.
      expect(resolveShortcut(press('z', { metaKey: true, altKey: true }))).toBeNull();
      expect(resolveShortcut(press('/', { ctrlKey: true, altKey: true }))).toBe('help');
    });
  });

  describe('WCAG 2.1 SC 2.1.4 — no single-character shortcuts', () => {
    it('binds no printable character without a modifier', () => {
      const printable = 'abcdefghijklmnopqrstuvwxyz0123456789?/+-=[]\\;\',.`';
      for (const ch of printable) {
        expect(resolveShortcut(press(ch))).toBeNull();
        expect(resolveShortcut(press(ch.toUpperCase(), { shiftKey: true }))).toBeNull();
      }
    });
  });
});

describe('EDITOR_SHORTCUTS', () => {
  it('describes exactly what the resolver implements, and nothing more', () => {
    // The sheet and the resolver read the same array, so this is what stops a
    // shortcut being documented but dead, or live but unlisted.
    const listed = EDITOR_SHORTCUTS.map((s) => s.id).sort();
    const implemented: ShortcutId[] = [
      'undo', 'redo', 'copy', 'cut', 'paste', 'duplicate', 'delete', 'save',
      'nudge-up', 'nudge-down', 'nudge-left', 'nudge-right',
      'context-menu', 'help', 'cancel',
    ];
    expect(listed).toEqual([...implemented].sort());
    expect(new Set(listed).size).toBe(listed.length); // one entry per id
  });

  it('gives every entry keys and a label to render', () => {
    for (const spec of EDITOR_SHORTCUTS) {
      expect(spec.keys.length).toBeGreaterThan(0);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it('writes aria-keyshortcuts as UI Events key names, never glyphs', () => {
    // `aria-keyshortcuts="⌘Z"` is silently ignored by everything that reads the
    // attribute at all.
    for (const spec of EDITOR_SHORTCUTS) {
      if (!spec.aria) continue;
      expect(spec.aria).not.toMatch(/[⌘⇧⌥↑↓←→]/);
      expect(spec.aria).toMatch(/^[A-Za-z0-9+ ]+$/);
    }
  });
});

describe('nudge vectors', () => {
  it('are physical, so an arrow key means the same thing in a Hebrew locale', () => {
    // The page under them is a raster and an SVG user-space layer; neither
    // mirrors under dir="rtl", so a direction-relative arrow would move a shape
    // the opposite way from the key that was pressed.
    expect(NUDGE_VECTORS['nudge-left']).toEqual([-1, 0]);
    expect(NUDGE_VECTORS['nudge-right']).toEqual([1, 0]);
    expect(NUDGE_VECTORS['nudge-up']).toEqual([0, -1]);
    expect(NUDGE_VECTORS['nudge-down']).toEqual([0, 1]);
  });
});

describe('labels', () => {
  it('gives every glyph the word a screen reader should say', () => {
    expect(keyLabel('Mod', true)).toEqual({ glyph: '⌘', name: 'Command' });
    expect(keyLabel('Mod', false)).toEqual({ glyph: 'Ctrl', name: 'Control' });
    expect(keyLabel('←', true).name).toBe('Arrow left');
    expect(keyLabel('Esc', false).name).toBe('Escape');
  });

  it('titles a control the way its platform writes the key', () => {
    expect(shortcutTitle('undo', true)).toBe('⌘Z');
    expect(shortcutTitle('undo', false)).toBe('Ctrl+Z');
    expect(shortcutTitle('redo', true)).toBe('⌘⇧Z');
  });
});

describe('isTypingTarget', () => {
  it('recognises the elements the browser should be editing', () => {
    expect(isTypingTarget(field('input'))).toBe(true);
    expect(isTypingTarget(field('textarea'))).toBe(true);
    expect(isTypingTarget(field('select'))).toBe(true);
    expect(isTypingTarget(field('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
