import { DOCUMENT } from '@angular/common';
import { Directive, ElementRef, OnDestroy, inject } from '@angular/core';
import { ConfigurableFocusTrapFactory } from '@angular/cdk/a11y';

/**
 * What a dialog owes a keyboard user (§10.3).
 *
 * Three things, none of which a `<div>` does on its own:
 *
 * * **Focus goes in.** Otherwise Tab starts from wherever it was, which is
 *   behind the overlay — the person is typing into a form they cannot see.
 * * **Focus stays in** until the dialog is answered. A trap sounds hostile and
 *   is the opposite: it is what makes "press Escape to leave" the only way out
 *   rather than "wander off and hope".
 * * **Focus comes back** to whatever opened it, so the next Tab continues from
 *   where the person was rather than from the top of the page.
 *
 * Escape closes, because a dialog somebody cannot dismiss without a mouse is
 * the barrier this exists to remove. The host decides what closing *means* —
 * `(zenModalEscape)` fires and the component answers.
 *
 * Applied with `role="dialog" aria-modal="true"` on the same element; those are
 * the part a screen reader reads, and the trap is the part it needs to be true.
 */
@Directive({
  selector: '[zenModal]',
  host: {
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class ZenModal implements OnDestroy {
  // Not `inject(ElementRef<HTMLElement>)`, which reads as though it types the
  // host and does not — that is an instantiation expression, and `inject`
  // resolves it back to `ElementRef<any>`. Same emitted call either way.
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private doc = inject(DOCUMENT);
  private factory = inject(ConfigurableFocusTrapFactory);

  private trap = this.factory.create(this.host.nativeElement);
  private restoreTo = this.doc.activeElement as HTMLElement | null;

  constructor() {
    // `focusInitialElementWhenReady` waits a tick for the content to render,
    // which matters because the dialog and its contents appear together.
    void this.trap.focusInitialElementWhenReady();
  }

  protected onEscape(event: Event): void {
    this.host.nativeElement.dispatchEvent(
      new CustomEvent('zenModalEscape', { bubbles: false }),
    );
    event.stopPropagation();
  }

  ngOnDestroy(): void {
    this.trap.destroy();
    this.restoreTo?.focus?.();
  }
}
