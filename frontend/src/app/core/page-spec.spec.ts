import { formatPages, parsePageSpec, toIndices, uniquePages } from './page-spec';

/**
 * The extract and delete tools act on exactly what this returns, so every case
 * here is a page somebody would otherwise have lost or received by mistake.
 */
describe('parsePageSpec', () => {
  it('reads single pages, ranges and a mix of both', () => {
    expect(parsePageSpec('3').pages).toEqual([3]);
    expect(parsePageSpec('2-5').pages).toEqual([2, 3, 4, 5]);
    expect(parsePageSpec('1, 3, 5-8').pages).toEqual([1, 3, 5, 6, 7, 8]);
  });

  it('forgives the separators people actually type', () => {
    const expected = [1, 2, 3, 7];
    expect(parsePageSpec('1 - 3, 7').pages).toEqual(expected);
    expect(parsePageSpec('1–3 7').pages).toEqual(expected); // en dash, autocorrected
    expect(parsePageSpec(' 1—3 ; 7 ').pages).toEqual(expected); // em dash
  });

  it('keeps the order it was given — the extract comes out that way', () => {
    expect(parsePageSpec('9, 2, 40').pages).toEqual([9, 2, 40]);
  });

  it('treats empty text as unfinished, not wrong', () => {
    expect(parsePageSpec('')).toEqual({ pages: [], error: null });
    expect(parsePageSpec('   ')).toEqual({ pages: [], error: null });
  });

  it('explains what is wrong instead of guessing', () => {
    expect(parsePageSpec('first two').error).toContain('not a page number');
    expect(parsePageSpec('0').error).toContain('numbered from 1');
    expect(parsePageSpec('8-5').error).toContain('runs backwards');
    expect(parsePageSpec('1-99999').error).toContain('more pages');
  });

  it('reports no pages alongside an error, so nothing can run on half a spec', () => {
    expect(parsePageSpec('1, 3, oops').pages).toEqual([]);
  });
});

describe('page helpers', () => {
  it('collapses repeats, first occurrence winning', () => {
    expect(uniquePages([3, 1, 3, 1])).toEqual([3, 1]);
  });

  it('converts to the 0-based indices the API takes', () => {
    expect(toIndices([1, 3, 8])).toEqual([0, 2, 7]);
  });

  it('summarises a selection back as runs', () => {
    expect(formatPages([1, 3, 5, 6, 7, 8])).toBe('1, 3, 5–8');
    expect(formatPages([4, 2, 3])).toBe('2–4');
  });
});
