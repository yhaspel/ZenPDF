import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { GuestBanner } from '../../shared/guest-banner';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, GuestBanner],
  template: `
    <div class="flex min-h-screen flex-col bg-slate-50">
      <header class="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <a [routerLink]="auth.isAuthenticated() ? '/app/dashboard' : '/'"
           class="flex items-center gap-2 font-bold text-slate-800">
          <span>🧘‍♀️</span> ZenPDF
        </a>
        <nav class="flex items-center gap-6 text-sm">
          @if (auth.isAuthenticated()) {
            <a routerLink="/app/dashboard" routerLinkActive="text-indigo-600 font-medium"
               class="text-slate-600" data-test="nav-dashboard">Documents</a>
            <a routerLink="/app/settings" routerLinkActive="text-indigo-600 font-medium"
               class="text-slate-600" data-test="nav-settings">Settings</a>
            <span class="text-slate-500">{{ auth.user()?.email }}</span>
            <button (click)="auth.logout()" class="text-slate-600 hover:text-rose-600" data-test="logout">
              Log out
            </button>
          } @else {
            <!-- A guest gets a way in, never a wall (§21.3). -->
            <a routerLink="/" class="text-slate-600" data-test="nav-tools">All tools</a>
            <a routerLink="/auth/login" class="text-slate-600" data-test="nav-login">Log in</a>
            <a routerLink="/auth/register"
               class="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700"
               data-test="nav-register">Create free account</a>
          }
        </nav>
      </header>
      <app-guest-banner />
      <main class="flex-1">
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppShell {
  protected auth = inject(AuthFacade);
  protected guests = inject(GuestFacade);

  constructor() {
    this.auth.loadUser();
    this.guests.refresh();
  }
}
