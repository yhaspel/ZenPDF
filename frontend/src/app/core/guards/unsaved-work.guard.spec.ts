import { HasUnsavedWork, unsavedWorkGuard } from './unsaved-work.guard';

/**
 * The `canDeactivate` guard on the workspace. The component is asked, and its
 * answer is the guard's answer; a component that does not implement the
 * interface — or no component at all, as on a redirect — is let through.
 */
describe('unsavedWorkGuard', () => {
  const run = (component: unknown) =>
    (unsavedWorkGuard as (c: unknown, ...rest: unknown[]) => unknown)(
      component, {}, {}, {},
    );

  it('allows the navigation when the component says nothing is at stake', () => {
    const component: HasUnsavedWork = { confirmLeave: vi.fn(() => true) };
    expect(run(component)).toBe(true);
    expect(component.confirmLeave).toHaveBeenCalledTimes(1);
  });

  it('blocks the navigation when the component refuses', () => {
    expect(run({ confirmLeave: () => false })).toBe(false);
  });

  it('lets a component without the hook through', () => {
    expect(run({})).toBe(true);
  });

  it('lets a route with no component through', () => {
    expect(run(null)).toBe(true);
    expect(run(undefined)).toBe(true);
  });
});
