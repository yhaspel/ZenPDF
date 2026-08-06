import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { Brand } from '../../shared/brand';
import { GuestBanner } from '../../shared/guest-banner';
import { ThemeToggle } from '../../shared/theme-toggle';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, GuestBanner, Brand, ThemeToggle],
  template: `
    <div class="page-shell">
      <!-- Inside /app/doc/:id the workspace bar owns the top of the screen
           (design contract §3 headers, D3) — it carries its own brand, guest
           banner and theme toggle, so the shell steps aside entirely. -->
      @if (!inWorkspace()) {
        <header class="hdr">
          <a
            [routerLink]="auth.isAuthenticated() ? '/app/dashboard' : '/'"
            class="brand"
            aria-label="ZenPDF">
            <app-brand />
          </a>
          <nav>
            @if (auth.isAuthenticated()) {
              <a
                routerLink="/app/dashboard"
                routerLinkActive
                ariaCurrentWhenActive="page"
                data-test="nav-dashboard"
                >Documents</a
              >
              <a
                routerLink="/app/settings"
                routerLinkActive
                ariaCurrentWhenActive="page"
                data-test="nav-settings"
                >Settings</a
              >
              <span class="faint">{{ auth.user()?.email }}</span>
              <button type="button" class="linklike" (click)="auth.logout()" data-test="logout">
                Log out
              </button>
            } @else {
              <!-- A guest gets a way in, never a wall (§21.3). -->
              <a routerLink="/" data-test="nav-tools">All tools</a>
              <a routerLink="/auth/login" data-test="nav-login">Log in</a>
              <a
                routerLink="/auth/register"
                class="btn btn-secondary btn-sm"
                data-test="nav-register"
                >Create free account</a
              >
            }
            <app-theme-toggle />
          </nav>
        </header>
        <app-guest-banner />
      }
      <main class="flex flex-1 flex-col">
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppShell {
  protected auth = inject(AuthFacade);
  protected guests = inject(GuestFacade);
  private router = inject(Router);

  // Seeded from the router, then tracked: the shell outlives every navigation.
  private url = signal(this.router.url);
  protected readonly inWorkspace = computed(() => this.url().startsWith('/app/doc/'));

  constructor() {
    this.auth.loadUser();
    this.guests.refresh();
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationEnd) this.url.set(event.urlAfterRedirects);
    });
  }
}
