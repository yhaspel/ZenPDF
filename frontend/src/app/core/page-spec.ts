/**
 * Parsing for the page selections a visitor types on a tool page — "1, 3, 5-8".
 *
 * Pure, framework-free and in `core/` because it is shared by the extract and
 * delete tools and is the kind of thing that must be unit-tested rather than
 * clicked through: an off-by-one here silently hands somebody the wrong page.
 *
 * Numbers here are 1-based, the way they are printed on the page and the way a
 * person says them. The API is 0-based (§8), so `toIndices` is the single place
 * that conversion happens.
 */

export interface PageSelection {
  /** 1-based page numbers, in the order given. Empty when nothing was typed. */
  pages: number[];
  /** A sentence to show the user, or null when the text so far is fine. */
  error: string | null;
}

/**
 * Matches the schema's `maxItems` backstop (`_PAGES` in the backend). A
 * selection cannot usefully exceed it, and expanding "1-999999999" client-side
 * would hang the tab before the server ever got the chance to say no.
 */
const MAX_PAGES = 10000;

/** All three dashes a keyboard or an autocorrect can produce. */
const DASH = /\s*[-–—]\s*/g;

export function parsePageSpec(raw: string): PageSelection {
  const text = (raw ?? '').replace(DASH, '-').trim();
  if (!text) return { pages: [], error: null };

  const pages: number[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) {
      return { pages: [], error: `“${part}” is not a page number. Use numbers and ranges, like 1, 3, 5-8.` };
    }
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1) {
      return { pages: [], error: 'Pages are numbered from 1.' };
    }
    if (to < from) {
      return { pages: [], error: `“${part}” runs backwards. Put the lower page first, like 5-8.` };
    }
    if (pages.length + (to - from + 1) > MAX_PAGES) {
      return { pages: [], error: 'That is more pages than a document here can hold.' };
    }
    for (let page = from; page <= to; page++) pages.push(page);
  }
  return { pages, error: null };
}

/** The same pages with repeats dropped, first occurrence winning. */
export function uniquePages(pages: number[]): number[] {
  const seen = new Set<number>();
  return pages.filter((page) => (seen.has(page) ? false : (seen.add(page), true)));
}

/** 1-based page numbers → the 0-based indices the API takes (§8). */
export function toIndices(pages: number[]): number[] {
  return pages.map((page) => page - 1);
}

/** "1, 3, 5-8" from a list of pages — for summarising a selection back. */
export function formatPages(pages: number[]): string {
  const sorted = uniquePages(pages).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(end === start ? `${sorted[start]}` : `${sorted[start]}–${sorted[end]}`);
    start = end + 1;
  }
  return parts.join(', ');
}
