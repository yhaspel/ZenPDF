import {
  Measure,
  TEXT_ASCENT,
  TEXT_DESCENT,
  arimoMeasure,
  expandTabs,
  layoutText,
  paragraphDir,
  textBaseline,
} from './text-layout';

/** Every character 1 pt wide per point of size — widths you can count. */
const fixed: Measure = (text, size) => Array.from(text).length * size;

describe('layoutText', () => {
  it('keeps a line that fits as it is, and sizes the box from it', () => {
    const laid = layoutText('hello', 1, 100, fixed);
    expect(laid.lines).toEqual(['hello']);
    expect(laid.widthPt).toBe(5);
    expect(laid.heightPt).toBeCloseTo(1.2, 10);
  });

  it('keeps the user\'s own line breaks, including empty lines', () => {
    const laid = layoutText('one\n\nthree', 1, 100, fixed);
    expect(laid.lines).toEqual(['one', '', 'three']);
    expect(laid.heightPt).toBeCloseTo(3 * 1.2, 10);
    expect(laid.widthPt).toBe(5);
  });

  it('never returns no lines', () => {
    expect(layoutText('', 12, 100, fixed).lines).toEqual(['']);
    expect(layoutText('', 12, 100, fixed).widthPt).toBe(0);
  });

  it('breaks at the edge by word, dropping the space at the break', () => {
    const laid = layoutText('aaa bbb ccc', 1, 7, fixed);
    expect(laid.lines).toEqual(['aaa bbb', 'ccc']);
    expect(laid.widthPt).toBe(7);
  });

  it('keeps a space typed at the end of a wrapped paragraph, without widening the box', () => {
    const laid = layoutText('aaa bbb ccc ', 1, 7, fixed);
    expect(laid.lines).toEqual(['aaa bbb', 'ccc ']);
    expect(laid.widthPt).toBe(7);
    expect(layoutText('ab ', 1, 100, fixed).widthPt).toBe(2);
  });

  it('breaks a word wider than the space by character', () => {
    const laid = layoutText('abcdefghij xy', 1, 4, fixed);
    expect(laid.lines).toEqual(['abcd', 'efgh', 'ij', 'xy']);
    for (const line of laid.lines) expect(fixed(line, 1)).toBeLessThanOrEqual(4);
  });

  it('makes progress even with no room at all', () => {
    expect(layoutText('abc', 1, 0, fixed).lines).toEqual(['a', 'b', 'c']);
  });

  it('treats \\r\\n as one break', () => {
    expect(layoutText('a\r\nb', 1, 10, fixed).lines).toEqual(['a', 'b']);
  });

  it('is idempotent: re-laying the output at its own width reproduces it', () => {
    const texts = [
      'the quick brown fox jumps over the lazy dog',
      'short\nand a much longer second line that wraps',
      'supercalifragilistic expialidocious',
    ];
    for (const text of texts) {
      const first = layoutText(text, 1, 11, fixed);
      const again = layoutText(first.lines.join('\n'), 1, first.widthPt, fixed);
      expect(again.lines).toEqual(first.lines);
      expect(again.widthPt).toBe(first.widthPt);
    }
  });
});

describe('paragraphDir', () => {
  it('is decided by the first strong character', () => {
    expect(paragraphDir('שלום world')).toBe('rtl');
    expect(paragraphDir('world שלום')).toBe('ltr');
    expect(paragraphDir('12, רחוב הרצל')).toBe('rtl'); // digits are weak
    expect(paragraphDir('  "مرحبا"')).toBe('rtl');
    expect(paragraphDir('12 ,')).toBe('ltr');
    expect(paragraphDir('')).toBe('ltr');
  });

  // The same table is in the engine's test_annotations.py
  // (`test_paragraph_direction_matches_the_clients_rule`): one rule, both sides.
  it.each([
    ['‏12 Main St', 'rtl'], // RLM decides
    ['‎שלום', 'ltr'], // LRM decides
    ['١٢ items', 'ltr'], // Arabic-Indic digits are weak
    ['۱۲ items', 'ltr'], // so are the extended ones
    ['﻿Hello', 'ltr'], // a BOM is a format character
    ['ָשלום', 'rtl'], // a point is a mark; the letter decides
    ['𞤀𞤁 12 abc', 'rtl'], // Adlam, a supplementary RTL script
    ['Ωmega', 'ltr'],
  ] as const)('agrees with the engine on %j', (text, dir) => {
    expect(paragraphDir(text)).toBe(dir);
  });
});

describe('tabs', () => {
  it('are laid out as four spaces, so the screen and the file advance alike', () => {
    expect(expandTabs('Name\tValue')).toBe('Name    Value');
    const laid = layoutText('Name\tValue', 1, 100, fixed);
    expect(laid.lines).toEqual(['Name    Value']);
    expect(laid.widthPt).toBe(13);
  });
});

describe('textBaseline', () => {
  it('is the engine\'s formula (annotations.text_baseline)', () => {
    // 52 + baseline(0, 12) = 63.36 — the value the engine test pins.
    expect(52 + textBaseline(0, 12)).toBeCloseTo(63.36015625, 8);
    expect(textBaseline(1, 12) - textBaseline(0, 12)).toBeCloseTo(14.4, 10);
    expect(textBaseline(0, 10)).toBeCloseTo(((1.2 - (TEXT_ASCENT + TEXT_DESCENT)) / 2 + TEXT_ASCENT) * 10, 10);
  });
});

describe('arimoMeasure', () => {
  const measure = arimoMeasure();

  it('sums Arimo\'s own advances (the engine\'s Font.text_length)', () => {
    // Arimo: space 569, "A" 1366 units of 2048 — the same numbers PyMuPDF uses.
    expect(measure(' ', 2048)).toBe(569);
    expect(measure('A', 2048)).toBe(1366);
    // What the engine's `Font("Arimo-Regular.ttf").text_length("Yuval Haspel",
    // fontsize=12)` answers.
    expect(measure('Yuval Haspel', 12)).toBeCloseTo(70.705078125, 9);
  });

  it('covers Hebrew', () => {
    expect(measure('א', 2048)).toBeGreaterThan(0);
    expect(measure('רחוב', 12)).toBeGreaterThan(measure('ר', 12));
  });

  it('does not kern: a pair is the sum of its parts', () => {
    expect(measure('AV', 12)).toBeCloseTo(measure('A', 12) + measure('V', 12), 10);
  });

  it('asks the fallback for a character outside the table', () => {
    const withFallback = arimoMeasure(() => 7);
    expect(withFallback('😀', 12)).toBe(7);
  });
});
