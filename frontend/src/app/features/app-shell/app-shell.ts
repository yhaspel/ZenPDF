import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="flex min-h-screen flex-col bg-slate-50">
      <header class="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <a routerLink="/app/dashboard" class="flex items-center gap-2 font-bold text-slate-800">
          <span>🧘‍♀️</span> ZenPDF
        </a>
        <nav class="flex items-center gap-6 text-sm">
          <a routerLink="/app/dashboard" routerLinkActive="text-indigo-600 font-medium"
             class="text-slate-600" data-test="nav-dashboard">Documents</a>
          <a routerLink="/app/settings" routerLinkActive="text-indigo-600 font-medium"
             class="text-slate-600" data-test="nav-settings">Settings</a>
          <span class="text-slate-400">{{ auth.user()?.email }}</span>
          <button (click)="auth.logout()" class="text-slate-600 hover:text-rose-600" data-test="logout">
            Log out
          </button>
        </nav>
      </header>
      <main class="flex-1">
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppShell {
  protected auth = inject(AuthFacade);
}
