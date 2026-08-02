/**
 * The retention numbers, as the prerendered legal pages state them (§9A).
 *
 * These pages are prerendered at build time, where `/api/config/` cannot be
 * fetched — so the crawled HTML, and everything a visitor sees before
 * hydration, comes from here. That makes this file a *claim*, not a fallback:
 * `apps/core/tests/test_ads_and_abuse.py` reads it and asserts each number
 * equals the Django setting the beat sweepers actually use, so the policy and
 * the sweeper cannot drift apart without a red test.
 *
 * The live config still wins once it arrives, for a running instance that was
 * configured differently.
 */
export const RETENTION = {
  guest_hours: 24,
  trash_days: 30,
  export_hours: 24,
  job_days: 365,
  job_params_days: 30,
} as const;
