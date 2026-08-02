import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { AuthFacade } from './abstraction/auth.facade';
import { GuestFacade } from './abstraction/guest.facade';
import { ConfirmHost } from './shared/confirm-host';
import { ConsentBanner } from './shared/consent-banner';
import { ToastHost } from './shared/toast-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, ConfirmHost, ConsentBanner],
  template: `
    <router-outlet />
    <app-toast-host />
    <app-confirm-host />
    <app-consent-banner />
  `,
})
export class App {
  constructor() {
    inject(AuthFacade).loadUser();
    // Once, at start. Everything cross-cutting reads this payload — the tier
    // limits, whether ads are on, whether this visitor must be asked, and the
    // retention numbers the privacy page prints — and a public GET with no
    // side effects is the right shape for that (it never mints a session).
    inject(GuestFacade).loadConfig();
  }
}
