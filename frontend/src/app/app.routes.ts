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
        path: 'settings',
        canActivate: [accountGuard],
        data: { accountReason: 'settings' },
        loadComponent: () => import('./features/settings/settings').then((m) => m.Settings),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
