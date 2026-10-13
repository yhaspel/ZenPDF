import { RETENTION } from './retention';

/**
 * The retention numbers the prerendered legal pages state (§9A). They are a
 * *claim* about the sweepers, pinned on the backend side by
 * `apps/core/tests/test_ads_and_abuse.py`; this side pins the shape the legal
 * page reads, so a renamed key cannot silently blank a sentence there.
 */
describe('RETENTION', () => {
  it.each([
    ['guest_hours', 24],
    ['trash_days', 30],
    ['export_hours', 24],
    ['job_days', 365],
    ['job_params_days', 30],
  ] as const)('states %s as %i', (key, value) => {
    expect(RETENTION[key]).toBe(value);
  });

  it('carries exactly the keys the legal page and the backend test agree on', () => {
    expect(Object.keys(RETENTION).sort()).toEqual(
      ['export_hours', 'guest_hours', 'job_days', 'job_params_days', 'trash_days'],
    );
  });

  it('is whole positive numbers throughout — a sweeper cannot run every 1.5 days', () => {
    for (const value of Object.values(RETENTION)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
