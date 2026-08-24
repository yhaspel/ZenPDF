import { defineConfig } from 'vitest/config';

/**
 * The unit runner's per-test budget (`angular.json` → `test.options.runnerConfig`).
 *
 * **Why this file exists.** Vitest's default `testTimeout` is 5 s, and the gate went
 * red twice with `Test timed out in 5000ms` on `workspace-drew.spec.ts`'s first case —
 * a spec the change under test never touched. Measured in the project's own container
 * (`docker compose run --rm --no-deps web npx ng test`), on that case:
 *
 * | run | that case |
 * |---|---|
 * | that spec file alone | **468 ms** |
 * | whole suite, 58 files | **1 197 ms** |
 * | whole suite, 62 files | **3 110 ms** |
 * | whole suite, inside `infra/test.sh` alongside the rest of the gate | **> 5 000 ms — red** |
 *
 * **What that time actually is — corrected 2026-08-24.** This file first said the
 * seconds were Angular compiling the workspace template on the first
 * `TestBed.createComponent`. That was wrong: `@angular/build:unit-test` builds the
 * suite **AOT**, so nothing compiles a template at test time. What is being paid is
 * per-*worker* jsdom + zone + Angular-runtime warm-up — `isolate` defaults to `false`
 * here, so a worker pays it once and charges it to whichever file ran first, and
 * vitest's sequencer orders files by the previous run's durations, which puts the
 * slowest one first and makes it pay every time. That is why it stopped being random
 * when four spec files were added. The runner's own cache disproves the component
 * story outright: `undeletable.spec.ts` — seven trivial tests, no component at all —
 * has been measured at **3 901 ms** of the same warm-up, while
 * `workspace-phone.spec.ts` builds the whole `Workspace` **eight** times in 981 ms.
 * The repo had already recorded the mechanism at 38 spec files, long before any of
 * this work: PROGRESS, "jsdom setup contention, not logic".
 *
 * 15 s is 3× the default and roughly 5× the worst honest measurement, which leaves a
 * real hang still failing — just later. It is deliberately not larger: a budget that
 * cannot be exceeded stops being a budget.
 *
 * **`hookTimeout` is deliberately not set.** An earlier version of this file raised it
 * to 20 s alongside the test budget, with no measurement anywhere behind it.
 * `Hook timed out in 10000ms` is precisely the signal `infra/test.sh`'s long comment
 * and the PROGRESS row about the starved dev server are written against, and widening
 * a detector nobody had shown to be wrong is how a warning stops being read.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
