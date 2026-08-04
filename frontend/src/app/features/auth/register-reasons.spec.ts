import { Routes } from '@angular/router';

import { routes } from '../../app.routes';
import { REASONS } from './register';

/**
 * L2 — the account gate's copy key.
 *
 * `/app/sign/new/:docId` and `/app/sign/:id` declared `accountReason: 'signing'`
 * while the map is keyed `sign`, so the lookup missed and the register page fell
 * back to "Create a free account to use this feature." — the generic sentence,
 * shown at the single highest-intent moment in the product. The two tables live
 * in different files, so nothing was going to notice; this is what notices.
 */
function accountReasons(table: Routes, seen: string[] = []): string[] {
  for (const route of table) {
    const reason = route.data?.['accountReason'];
    if (typeof reason === 'string') seen.push(reason);
    if (route.children) accountReasons(route.children, seen);
  }
  return seen;
}

describe('account-gate reasons', () => {
  it('finds the reasons declared in the route table', () => {
    const declared = accountReasons(routes);
    // If this ever hits zero the rest of the suite passes vacuously.
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toContain('sign');
  });

  it('resolves every declared reason to tailored copy, not the fallback', () => {
    for (const reason of accountReasons(routes)) {
      expect(REASONS[reason]).toBeDefined();
      expect(REASONS[reason]).not.toBe(REASONS['account']);
    }
  });

  it('tells someone stopped on the way to signing what signing needs', () => {
    expect(REASONS['sign']).toContain('signature');
  });
});
