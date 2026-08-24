import { defineConfig } from 'vitest/config';

/**
 * The unit runner's per-test budget (`angular.json` → `test.options.runnerConfig`).
 *
 * **Why this file exists.** Vitest's default `testTimeout` is 5 s, and a spec that
 * builds the whole `Workspace` component spends most of it on Angular compiling a
 * 500-line template and seven pane components — a cost that is paid once per worker
 * and lands inside the *first* `it()` of the file. Measured in the project's own
 * container (`docker compose run --rm --no-deps web npx ng test`), on
 * `workspace-drew.spec.ts`'s first case:
 *
 * | run | that case |
 * |---|---|
 * | that spec file alone | **468 ms** |
 * | whole suite, before the phone-workspace specs (58 files) | **1 197 ms** |
 * | whole suite, after them (62 files) | **3 110 ms** |
 * | whole suite, inside `infra/test.sh` alongside the rest of the gate | **> 5 000 ms — red** |
 *
 * So the number the default budget measures is *how busy the machine is*, not what
 * the code does — and it fails with `Test timed out in 5000ms` on a spec the change
 * under test never touched, which is exactly the false red `infra/test.sh` already
 * carries a long comment about (`docker compose stop web`, five recorded occurrences
 * on five branches, twice on branches that changed zero frontend files).
 *
 * 15 s is 3× the default and roughly 5× the worst honest measurement, which leaves a
 * real hang still failing — just later. It is deliberately not larger: a budget that
 * cannot be exceeded stops being a budget.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
