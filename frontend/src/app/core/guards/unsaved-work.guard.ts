import { CanDeactivateFn } from '@angular/router';

/**
 * A component that has work which must not be lost when the user routes away.
 *
 * Kept as a structural interface rather than importing the component, so the
 * guard does not drag the (lazily loaded) workspace chunk into the router.
 */
export interface HasUnsavedWork {
  /** Return false to block the navigation. */
  confirmLeave(): boolean;
}

/**
 * Routing away from the workspace commits unsaved annotations (phase-03 §2:
 * "autosave every 30 s / **on navigation**").
 *
 * Deliberately non-blocking. `beforeunload` covers leaving the *site*, where
 * there is no time to save; an in-app navigation has plenty, so the honest
 * behaviour is to save rather than to interrogate the user about it.
 */
export const unsavedWorkGuard: CanDeactivateFn<HasUnsavedWork> = (component) =>
  component?.confirmLeave?.() ?? true;
