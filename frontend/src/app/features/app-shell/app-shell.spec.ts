import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { User } from '../../core/models/models';
import { AppShell } from './app-shell';

@Component({ template: '' })
class Blank {}

/**
 * The app shell: the header every `/app/*` route shares.
 *
 * Three things it must get right, each a product rule rather than a layout
 * choice: a guest is shown a way in and never a wall (§21.3), the theme toggle
 * is never removed (contract §5), and inside `/app/doc/:id` the shell steps
 * aside entirely because the workspace bar owns the top of the screen (D3).
 * Loading the user and the guest state is also the shell's job — it is the
 * one component that outlives every navigation, so it is the right place to
 * do it once.
 */
describe('AppShell', () => {
  let fixture: ComponentFixture<AppShell>;
  let user: ReturnType<typeof signal<User | null>>;
  let authenticated: ReturnType<typeof signal<boolean>>;
  let logout: ReturnType<typeof vi.fn>;
  let loadUser: ReturnType<typeof vi.fn>;
  let refresh: ReturnType<typeof vi.fn>;

  const USER: User = {
    id: 'u1',
    email: 'sam@example.com',
    display_name: 'Sam',
    email_verified: true,
    accepted_tos_at: null,
    storage_bytes_used: 0,
    date_joined: '2026-08-01T00:00:00Z',
  };

  function render(signedIn: boolean): HTMLElement {
    user = signal<User | null>(signedIn ? USER : null);
    authenticated = signal(signedIn);
    logout = vi.fn();
    loadUser = vi.fn();
    refresh = vi.fn();
    TestBed.configureTestingModule({
      imports: [AppShell],
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        {
          provide: AuthFacade,
          useValue: { user, isAuthenticated: authenticated, logout, loadUser },
        },
        {
          provide: GuestFacade,
          useValue: {
            refresh,
            expiredNotice: signal(false),
            accountRequired: signal<string | null>(null),
            principal: signal<'guest' | 'user' | null>(signedIn ? 'user' : null),
            secondsRemaining: signal<number | null>(null),
            timeRemainingLabel: signal(''),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(AppShell);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const q = (sel: string) => fixture.nativeElement.querySelector(sel) as HTMLElement | null;

  afterEach(() => TestBed.resetTestingModule());

  it('loads the user and refreshes the guest state once, on construction', () => {
    render(false);
    expect(loadUser).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows a guest the tools, a login and a signup — a way in, never a wall', () => {
    const el = render(false);
    expect(q('[data-test="nav-tools"]')!.getAttribute('href')).toBe('/');
    expect(q('[data-test="nav-login"]')!.getAttribute('href')).toBe('/auth/login');
    expect(q('[data-test="nav-register"]')!.getAttribute('href')).toBe('/auth/register');
    expect(q('[data-test="nav-dashboard"]')).toBeNull();
    expect(q('[data-test="logout"]')).toBeNull();
    // The brand goes to the directory for somebody without an account.
    expect(el.querySelector('a.brand')!.getAttribute('href')).toBe('/');
  });

  it('shows a signed-in user their documents, settings, address and a way out', () => {
    const el = render(true);
    expect(q('[data-test="nav-dashboard"]')!.getAttribute('href')).toBe('/app/dashboard');
    expect(q('[data-test="nav-settings"]')!.getAttribute('href')).toBe('/app/settings');
    expect(q('[data-test="nav-email"]')!.textContent).toContain('sam@example.com');
    expect(q('[data-test="logout"]')).not.toBeNull();
    expect(q('[data-test="nav-login"]')).toBeNull();
    expect(q('[data-test="nav-register"]')).toBeNull();
    expect(el.querySelector('a.brand')!.getAttribute('href')).toBe('/app/dashboard');
  });

  it('signs out through the facade when Log out is pressed', () => {
    render(true);
    q('[data-test="logout"]')!.click();
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('keeps the theme toggle in the header for both principals', () => {
    render(false);
    expect(q('[data-test="theme-toggle"]')).not.toBeNull();
    TestBed.resetTestingModule();
    render(true);
    expect(q('[data-test="theme-toggle"]')).not.toBeNull();
  });

  it('follows the session: the menu switches when the facade does', () => {
    render(false);
    expect(q('[data-test="nav-login"]')).not.toBeNull();
    user.set(USER);
    authenticated.set(true);
    fixture.detectChanges();
    expect(q('[data-test="nav-login"]')).toBeNull();
    expect(q('[data-test="nav-dashboard"]')).not.toBeNull();
  });

  it('steps aside inside the workspace and comes back on leaving it', async () => {
    render(true);
    const router = TestBed.inject(Router);
    expect(q('header.hdr')).not.toBeNull();

    await router.navigateByUrl('/app/doc/abc123');
    fixture.detectChanges();
    expect(q('header.hdr')).toBeNull();
    expect(q('app-guest-banner')).toBeNull();
    // The outlet stays — the workspace renders through it.
    expect(q('router-outlet')).not.toBeNull();

    await router.navigateByUrl('/app/dashboard');
    fixture.detectChanges();
    expect(q('header.hdr')).not.toBeNull();
    expect(q('app-guest-banner')).not.toBeNull();
  });

  it('does not mistake the sign builder or the sign detail for the workspace', async () => {
    render(true);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/app/sign/new/abc123');
    fixture.detectChanges();
    expect(q('header.hdr')).not.toBeNull();

    await router.navigateByUrl('/app/sign/abc123');
    fixture.detectChanges();
    expect(q('header.hdr')).not.toBeNull();
  });
});
