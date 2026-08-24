import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { WsDrawer } from './ws-drawer';

/**
 * The bottom sheet's head — grip, title, close (design contract §3 **Phone
 * workspace**).
 *
 * A separate component from `WsDrawer` because that one is a directive on the
 * rail's own `<aside>`, and a directive has no template. It reads the drawer it
 * is inside through the element injector rather than taking a `label` of its
 * own: the title and the bottom bar's opener are the same words, and two places
 * to write them is one place for them to disagree.
 *
 * `display: contents` on the host, so on a desk — where it renders nothing —
 * it is not an empty flex item adding a `gap` to the rail.
 *
 * **Both hooks carry `data-drawer`** *(added 2026-08-24)*. A phone DOM has two
 * or three drawers in it at once — Annotate's two rails plus the workspace
 * bar's More sheet — so `[data-test=ws-drawer-close]` on its own resolves to
 * three elements and a suite has to guess which. That is the same trap the
 * workspace bar's cluster was built as one `<ng-template>` to avoid, and this
 * component walked straight into it: the bottom bar's opener has always
 * carried the discriminator, and the head it opens did not.
 */
@Component({
  selector: 'app-ws-drawer-head',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (drawer.shell.phone()) {
      <header class="ws-drawer-head" data-test="ws-drawer"
              [attr.data-drawer]="drawer.zenWsDrawer()">
        <span class="ws-drawer-grip" aria-hidden="true"></span>
        <div class="ws-drawer-titlerow">
          <h2 class="ws-drawer-title">{{ drawer.zenWsDrawerLabel() }}</h2>
          <button type="button" class="ws-drawer-close" (click)="drawer.close()"
                  [attr.aria-label]="'Close ' + drawer.zenWsDrawerLabel()"
                  [attr.data-drawer]="drawer.zenWsDrawer()"
                  data-test="ws-drawer-close">
            <svg class="ti ti-sm" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
            </svg>
          </button>
        </div>
      </header>
    }
  `,
})
export class WsDrawerHead {
  protected drawer = inject(WsDrawer);
}
