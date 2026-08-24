import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Put pdf.js's toolbar back in document order.
 *
 * `ngx-extended-pdf-viewer` renumbers every focusable element under the viewer
 * root with a **positive** tabindex — `assignTabindexes()` guards on
 * `if (this.startTabindex)`, which is the `InputSignal` *function* and therefore
 * always truthy, then writes `element.tabIndex = 0, 1, 2, …` across the whole
 * shell. Measured on `/app/doc/:id`: **152 elements with a positive tabindex**,
 * numbered 1 to 152.
 *
 * A positive tabindex is visited before *every* `tabindex="0"` element in the
 * document, so a keyboard user arriving at the workspace met 152 vendor
 * controls — most of them invisible, because we switch the sidebar, the editor
 * buttons and the secondary toolbar off — before reaching the back link, the
 * document title, `⋯` or the theme toggle. That is WCAG 2.4.3, not a lint.
 *
 * **This is a workaround and should be labelled one.** No option turns the
 * renumbering off: `startTabindex` only chooses the first number, and the guard
 * that was meant to make it opt-in cannot fail. The honest fix is upstream; this
 * directive goes when that lands.
 *
 * Negative values are left alone — `tabindex="-1"` is how the library's own
 * roving-focus groups work, and flattening those would break them.
 *
 * It hangs off the viewer's own `pageRendered` output rather than a timer: the
 * renumbering happens once, on `webviewerinitialized`, and a page having painted
 * is the first moment after that which we can observe. Re-running on every paint
 * is idempotent and costs one `querySelectorAll` on a surface that has just done
 * far more work than that.
 */
@Directive({
  // An attribute on the viewer element rather than the element itself, so the
  // workaround is visible at the call site — every `<ngx-extended-pdf-viewer>`
  // in the product should carry it, and the two that do say so in their markup.
  selector: 'ngx-extended-pdf-viewer[zenViewerTabOrder]',
  host: { '(pageRendered)': 'normalise()' },
})
export class ViewerTabOrder {
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected normalise(): void {
    const root = this.host.nativeElement;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[tabindex]'))) {
      if (el.tabIndex > 0) el.tabIndex = 0;
    }
  }
}
