import { Routes } from '@angular/router';

import { accountGuard } from './core/guards/account.guard';
import { unsavedWorkGuard } from './core/guards/unsaved-work.guard';
import { TOOL_PAGES } from './core/tool-pages';

/**
 * Public tool pages (§21.6) — one route per slug, built from the same table
 * that generates `sitemap.xml`, so the two can never drift. A tool page that
 * exists but is not in the sitemap is a bug.
 */
const toolRoutes: Routes = TOOL_PAGES.map((tool) => ({
  path: tool.slug,
  loadComponent: () => import('./features/tools/tool-page').then((m) => m.ToolPage),
  data: { tool },
}));

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/landing/landing').then((m) => m.Landing),
  },
  ...toolRoutes,
  {
    path: 'auth/login',
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: 'auth/register',
    loadComponent: () => import('./features/auth/register').then((m) => m.Register),
  },
  {
    // No app-wide guard any more: /app/doc/:id must render for either
    // principal (§7, §21.3). Only the three account-only routes are gated.
    path: 'app',
    loadComponent: () => import('./features/app-shell/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        canActivate: [accountGuard],
        data: { accountReason: 'library' },
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        // Open to guests — the entire workspace works with no account.
        path: 'doc/:id',
        canDeactivate: [unsavedWorkGuard],
        loadComponent: () => import('./features/workspace/workspace').then((m) => m.Workspace),
      },
      {
        // Sending a document for signature is account-only (§21.3): ESIGN
        // attribution needs an identified sender, and a guest-triggerable
        // outbound email path is a spam relay pointed at our own domain.
        path: 'sign/new/:docId',
        canActivate: [accountGuard],
        data: { accountReason: 'signing' },
        loadComponent: () =>
          import('./features/sign/request-builder').then((m) => m.RequestBuilder),
      },
      {
        path: 'sign/:id',
        canActivate: [accountGuard],
        data: { accountReason: 'signing' },
        loadComponent: () =>
          import('./features/sign/request-detail').then((m) => m.RequestDetail),
      },
      {
        path: 'settings',
        canActivate: [accountGuard],
        data: { accountReason: 'settings' },
        loadComponent: () => import('./features/settings/settings').then((m) => m.Settings),
      },
    ],
  },
  {
    // The ceremony and the verification page are public and carry no
    // credential at all — the token in the URL is the whole capability (§8B).
    path: 's/:token',
    loadComponent: () => import('./features/sign/ceremony').then((m) => m.Ceremony),
  },
  {
    path: 'legal/privacy',
    data: { kind: 'privacy' },
    loadComponent: () =>
      import('./features/legal/legal-page').then((m) => m.LegalPage),
  },
  {
    path: 'legal/terms',
    data: { kind: 'terms' },
    loadComponent: () =>
      import('./features/legal/legal-page').then((m) => m.LegalPage),
  },
  {
    path: 'about',
    data: { kind: 'about' },
    loadComponent: () =>
      import('./features/legal/legal-page').then((m) => m.LegalPage),
  },
  {
    // Somebody who clicked "unsubscribe" in a mail footer. No auth: the token
    // in the message is the authority (§9B).
    path: 'unsubscribe/:token',
    loadComponent: () =>
      import('./features/legal/unsubscribe-page').then((m) => m.UnsubscribePage),
  },
  {
    path: 'verify-email/:token',
    loadComponent: () =>
      import('./features/legal/verify-email-page').then((m) => m.VerifyEmailPage),
  },
  {
    // The consent text at a stable address, so a signer can read what they
    // agreed to without a live signing link (§7).
    path: 'legal/esign-disclosure',
    loadComponent: () =>
      import('./features/sign/disclosure-page').then((m) => m.DisclosurePage),
  },
  {
    path: 'verify',
    loadComponent: () => import('./features/sign/verify').then((m) => m.Verify),
  },
  {
    // A real 404 rather than a silent redirect: the person learns the address
    // was wrong, and a crawler is not told every dead link is the home page.
    path: '**',
    loadComponent: () => import('./features/legal/not-found').then((m) => m.NotFound),
  },
];
