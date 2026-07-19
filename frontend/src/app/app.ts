import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { AuthFacade } from './abstraction/auth.facade';
import { ConfirmHost } from './shared/confirm-host';
import { ToastHost } from './shared/toast-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, ConfirmHost],
  template: `
    <router-outlet />
    <app-toast-host />
    <app-confirm-host />
  `,
})
export class App {
  constructor() {
    inject(AuthFacade).loadUser();
  }
}
