import { TestBed } from '@angular/core/testing';

import { EditorClipboard } from './editor-clipboard.service';

describe('EditorClipboard', () => {
  let clipboard: EditorClipboard;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [EditorClipboard] });
    clipboard = TestBed.inject(EditorClipboard);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('starts empty', () => {
    expect(clipboard.kind()).toBeNull();
    expect(clipboard.has('annotation')).toBe(false);
    expect(clipboard.read('annotation')).toBeUndefined();
  });

  it('round-trips a payload of its own kind', () => {
    clipboard.copy('annotation', { id: 'a1', type: 'square' });
    expect(clipboard.kind()).toBe('annotation');
    expect(clipboard.has('annotation')).toBe(true);
    expect(clipboard.read<{ id: string }>('annotation')?.id).toBe('a1');
  });

  it('refuses to hand a payload to the wrong layer', () => {
    // A form field and a redaction area are both a rectangle on a page; pasting
    // one where the other belongs would produce a shape the receiving feature
    // cannot describe.
    clipboard.copy('form-field', { name: 'who' });
    expect(clipboard.read('redaction')).toBeUndefined();
    expect(clipboard.has('annotation')).toBe(false);
    expect(clipboard.read<{ name: string }>('form-field')?.name).toBe('who');
  });

  it('does not consume on read — paste repeats', () => {
    clipboard.copy('annotation', { id: 'a1' });
    expect(clipboard.read('annotation')).toBeDefined();
    expect(clipboard.read('annotation')).toBeDefined();
    expect(clipboard.has('annotation')).toBe(true);
  });

  it('replaces what it holds rather than accumulating', () => {
    clipboard.copy('annotation', { id: 'a1' });
    clipboard.copy('form-field', { name: 'who' });
    expect(clipboard.has('annotation')).toBe(false);
    expect(clipboard.kind()).toBe('form-field');
  });

  it('empties on clear', () => {
    clipboard.copy('annotation', { id: 'a1' });
    clipboard.clear();
    expect(clipboard.kind()).toBeNull();
  });
});
