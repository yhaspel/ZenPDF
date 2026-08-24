import { ConfigurableFocusTrapFactory, FocusTrap } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, ElementRef, computed, effect, inject, input } from '@angular/core';

import { WorkspaceShellFacade } from '../abstraction/workspace-shell.facade';

/**
 * A workspace rail that becomes a bottom sheet on a phone (design contract §3
 * **Phone workspace**).
 *
 * Applied to the `<aside>` that already *is* the rail rather than wrapping it,
 * because the same element has to be a plain rail in the desktop three-pane row
 * and a `role="dialog"` sheet below `md`. A wrapper that appeared at one width
 * and not the other would tear the rail's contents down and build them again on
 * every resize — and turning the `<aside>` into a component element would take
 * the `complementary` landmark off the desktop, which §10 does not allow. Here
 * the DOM is one shape at every width; CSS moves it, and this directive adds
 * the three things CSS cannot: the focus trap, Escape, and the body scroll lock.
 * The sheet's head is `<app-ws-drawer-head>`, the rail's first child.
 *
 * **The a11y is CDK's, not ours.** `ZenModal` (§3 modals) is the product's
 * dialog behaviour and it is built on `ConfigurableFocusTrapFactory`; it cannot
 * be reused verbatim here because it traps in its constructor and restores in
 * `ngOnDestroy`, which is right for an element that exists only while the dialog
 * is open and wrong for a rail that exists at every width. The same two CDK
 * calls are made on the open/close edge instead — no trap is hand-rolled.
 *
 * **The host's `data-test` is left alone.** One rail already has one
 * (`comments-sidebar`), and parity means keeping it, so the sheet's hook is
 * `data-ws-drawer` here and `data-test=ws-drawer` on the head — which is also
 * the honest assertion for "this rail is a drawer right now", since the head
 * exists only when it is.
 */
@Directive({
  selector: 'aside[zenWsDrawer]',
  host: {
    'class': 'ws-drawer',
    '[class.ws-drawer-open]': 'isOpen()',
    '[attr.id]': '"ws-drawer-" + zenWsDrawer()',
    '[attr.data-ws-drawer]': 'zenWsDrawer()',
    '[attr.role]': 'isOpen() ? "dialog" : null',
    '[attr.aria-modal]': 'isOpen() ? "true" : null',
    '[attr.aria-label]': 'isOpen() ? zenWsDrawerLabel() : null',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class WsDrawer {
  /** The key this rail is opened by — `start`, `end`, `more`. */
  readonly zenWsDrawer = input.required<string>();
  /** The sheet's title, and the label of the bottom bar's opener. */
  readonly zenWsDrawerLabel = input.required<string>();
  /** False for the **More** sheet, which the workspace bar's `⋯` already owns. */
  readonly zenWsDrawerBarOpener = input(true);

  readonly shell = inject(WorkspaceShellFacade);
  // Not `inject(ElementRef<HTMLElement>)`, which reads as though it types the
  // host and does not — that is an instantiation expression, and `inject`
  // resolves it back to `ElementRef<any>`. Same emitted call either way.
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private doc = inject(DOCUMENT);
  private factory = inject(ConfigurableFocusTrapFactory);

  readonly isOpen = computed(
    () => this.shell.phone() && this.shell.openDrawer() === this.zenWsDrawer(),
  );

  private trap: FocusTrap | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect(() => this.shell.registerDrawer({
      key: this.zenWsDrawer(),
      label: this.zenWsDrawerLabel(),
      barOpener: this.zenWsDrawerBarOpener(),
    }));
    destroyRef.onDestroy(() => {
      this.shell.unregisterDrawer(this.zenWsDrawer());
      this.release();
    });
    effect(() => (this.isOpen() ? this.capture() : this.release()));
  }

  close(): void {
    this.shell.closeDrawer();
  }

  protected onEscape(event: Event): void {
    if (!this.isOpen()) return;
    // The surface underneath must not also act on the key — the same rule the
    // context menu follows (§3) and for the same reason.
    event.stopPropagation();
    this.close();
  }

  private capture(): void {
    if (this.trap) return;
    this.trap = this.factory.create(this.host.nativeElement);
    void this.trap.focusInitialElementWhenReady();
    // A sheet you can scroll the page behind is a sheet that moves when you try
    // to use it (§3). A class, not an inline style, so nothing has to remember
    // what `overflow` was before.
    this.doc.body.classList.add('ws-drawer-locked');
  }

  private release(): void {
    if (!this.trap) return;
    this.trap.destroy();
    this.trap = null;
    this.doc.body.classList.remove('ws-drawer-locked');
    // Back to the opener, because the opener is where the person was. Found by
    // id rather than by remembering `activeElement`: a drawer also closes on the
    // scrim, on Escape and on a mode change, and in two of those three the
    // element that opened it is no longer the active one.
    this.doc.getElementById(`ws-drawer-open-${this.zenWsDrawer()}`)?.focus?.();
  }
}
