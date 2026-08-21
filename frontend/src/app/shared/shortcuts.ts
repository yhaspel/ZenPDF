/**
 * The editor's keyboard map (phase-12 D4, D5).
 *
 * One table, two consumers: `resolveShortcut` reads it to decide what a key
 * event means, and the shortcuts sheet renders it to tell people. A spec asserts
 * the two directions match, so a shortcut cannot be implemented but undocumented
 * or listed but dead.
 *
 * `resolveShortcut` is a pure function of the event — no DOM reads, no component
 * state, no platform sniffing — which is what makes every rule below a two-line
 * test rather than a browser session.
 */

export type ShortcutId =
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'save'
  | 'nudge-up'
  | 'nudge-down'
  | 'nudge-left'
  | 'nudge-right'
  | 'context-menu'
  | 'help'
  | 'cancel';

export interface ShortcutSpec {
  id: ShortcutId;
  /** How to *say* the binding. Rendered as separate `<kbd>`s by the sheet. */
  keys: string[];
  label: string;
  group: 'Editing' | 'Placing' | 'Everywhere';
  /**
   * The `aria-keyshortcuts` value, which takes UI Events key names joined by
   * `+` and separated by spaces — never a glyph. `aria-keyshortcuts="⌘Z"` is
   * silently ignored by every AT that reads the attribute at all.
   */
  aria?: string;
}

/** Exactly one entry per `ShortcutId`; `shortcuts.spec.ts` asserts both ways. */
export const EDITOR_SHORTCUTS: readonly ShortcutSpec[] = [
  { id: 'undo', keys: ['Mod', 'Z'], label: 'Undo', group: 'Editing',
    aria: 'Control+Z Meta+Z' },
  { id: 'redo', keys: ['Mod', 'Shift', 'Z'], label: 'Redo', group: 'Editing',
    aria: 'Control+Shift+Z Meta+Shift+Z' },
  { id: 'copy', keys: ['Mod', 'C'], label: 'Copy the selected item', group: 'Editing',
    aria: 'Control+C Meta+C' },
  { id: 'cut', keys: ['Mod', 'X'], label: 'Cut the selected item', group: 'Editing',
    aria: 'Control+X Meta+X' },
  { id: 'paste', keys: ['Mod', 'V'], label: 'Paste onto this page', group: 'Editing',
    aria: 'Control+V Meta+V' },
  { id: 'duplicate', keys: ['Mod', 'D'], label: 'Duplicate the selected item', group: 'Editing',
    aria: 'Control+D Meta+D' },
  { id: 'delete', keys: ['Delete'], label: 'Delete the selected item', group: 'Editing',
    aria: 'Delete Backspace' },
  { id: 'save', keys: ['Mod', 'S'], label: 'Save this session', group: 'Editing',
    aria: 'Control+S Meta+S' },
  { id: 'nudge-up', keys: ['↑'], label: 'Move up (hold Shift for ten times as far)',
    group: 'Placing' },
  { id: 'nudge-down', keys: ['↓'], label: 'Move down', group: 'Placing' },
  { id: 'nudge-left', keys: ['←'], label: 'Move left', group: 'Placing' },
  { id: 'nudge-right', keys: ['→'], label: 'Move right', group: 'Placing' },
  { id: 'context-menu', keys: ['Shift', 'F10'], label: 'Open the menu for the selection',
    group: 'Placing', aria: 'Shift+F10 ContextMenu' },
  { id: 'help', keys: ['Mod', '/'], label: 'Keyboard shortcuts', group: 'Everywhere',
    aria: 'Control+Slash Meta+Slash' },
  { id: 'cancel', keys: ['Esc'], label: 'Cancel — close a menu, drop a selection',
    group: 'Everywhere', aria: 'Escape' },
];

/** How much of the page one arrow press moves a shape; Shift multiplies it. */
export const NUDGE_STEP = 0.0025;
export const NUDGE_SHIFT_MULTIPLIER = 10;

/** The nudge ids and the (dx, dy) each one means, in normalized page units.
 *
 *  Deliberately **physical**, not writing-direction relative (phase-12 D9): the
 *  thing being moved is a page raster and an SVG user-space layer, neither of
 *  which mirrors under `dir="rtl"`, so `ArrowLeft` must move a shape left in a
 *  Hebrew locale exactly as it does in an English one. Every direct-manipulation
 *  editor behaves this way; the contract's logical-properties rule is about
 *  layout CSS, and §8 records the exception. */
export const NUDGE_VECTORS: Record<string, [number, number]> = {
  'nudge-up': [0, -1],
  'nudge-down': [0, 1],
  'nudge-left': [-1, 0],
  'nudge-right': [1, 0],
};

/**
 * Is the keystroke destined for a text field?
 *
 * If so the browser's own editing keys are the right ones — ⌘Z undoes typing,
 * Backspace deletes a character — and ours must keep out of the way.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * What a key event means, or `null` for "not ours".
 *
 * @param opts.hasTextSelection the caller's reading of `window.getSelection()`.
 * Passed in rather than read here so the function stays pure — and because the
 * caller is the only one that knows whether the selection is inside a surface
 * where copying text is the sensible interpretation.
 */
export function resolveShortcut(
  event: KeyboardEvent,
  opts: { hasTextSelection?: boolean } = {},
): ShortcutId | null {
  const key = event.key;

  // Escape is the one binding that survives a focused field: it means "get me
  // out of this", which is precisely what someone in a text box may want.
  if (key === 'Escape') return 'cancel';
  if (isTypingTarget(event.target)) return null;

  // AltGr is reported by Windows as ctrl+alt, and on German, Nordic, Polish and
  // Czech layouts `/` is an AltGr composition — so a blanket alt-veto would put
  // the help sheet out of reach on those keyboards. Alt *alone* is never ours.
  if (event.altKey && !event.ctrlKey) return null;

  const mod = event.metaKey || event.ctrlKey;

  if (mod) {
    const lower = key.length === 1 ? key.toLowerCase() : key;
    switch (lower) {
      case 'z':
        return event.shiftKey ? 'redo' : 'undo';
      case 'y':
        // Windows' other redo. Never on ⌘, where the browser owns it.
        return event.metaKey ? null : 'redo';
      case 'c':
        return opts.hasTextSelection ? null : 'copy';
      case 'x':
        return opts.hasTextSelection ? null : 'cut';
      case 'v':
        return 'paste';
      case 'd':
        return 'duplicate';
      case 's':
        return 'save';
      case '/':
        return 'help';
      default:
        return null;
    }
  }

  if (event.shiftKey && key === 'F10') return 'context-menu';
  if (key === 'ContextMenu') return 'context-menu';

  switch (key) {
    case 'Delete':
    case 'Backspace':
      return 'delete';
    case 'ArrowUp':
      return 'nudge-up';
    case 'ArrowDown':
      return 'nudge-down';
    case 'ArrowLeft':
      return 'nudge-left';
    case 'ArrowRight':
      return 'nudge-right';
    default:
      return null;
  }
}

/** True on a platform where ⌘ is the modifier, for labelling only. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
}

/** The glyph and the *spoken* name for one key of a `ShortcutSpec`. */
export function keyLabel(key: string, apple = isApplePlatform()): { glyph: string; name: string } {
  switch (key) {
    case 'Mod':
      return apple ? { glyph: '⌘', name: 'Command' } : { glyph: 'Ctrl', name: 'Control' };
    case 'Shift':
      return apple ? { glyph: '⇧', name: 'Shift' } : { glyph: 'Shift', name: 'Shift' };
    case 'Esc':
      return { glyph: 'Esc', name: 'Escape' };
    case '↑':
      return { glyph: '↑', name: 'Arrow up' };
    case '↓':
      return { glyph: '↓', name: 'Arrow down' };
    case '←':
      return { glyph: '←', name: 'Arrow left' };
    case '→':
      return { glyph: '→', name: 'Arrow right' };
    default:
      return { glyph: key, name: key };
  }
}

/** "⌘Z" / "Ctrl+Z" — for a `title`, where a glyph is the friendlier form. */
export function shortcutTitle(id: ShortcutId, apple = isApplePlatform()): string {
  const spec = EDITOR_SHORTCUTS.find((s) => s.id === id);
  if (!spec) return '';
  const parts = spec.keys.map((k) => keyLabel(k, apple).glyph);
  return apple ? parts.join('') : parts.join('+');
}
