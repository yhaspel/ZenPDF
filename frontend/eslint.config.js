// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');
const subscriptionsDieWithTheComponent =
  require('./tools/eslint-rules/subscriptions-die-with-the-component');

// Why `recommendedTypeChecked` and not `strictTypeChecked`. Both were run over
// this tree on 2026-08-24 — 344 findings against 894 — and four of strict's
// rules account for 570 of the difference. Each is off for what it fires on
// here, not for how often. Written down rather than left implicit so the next
// session that wonders whether to tighten the preset finds the measurement
// instead of repeating it. Counts are app code.
//
//   no-confusing-void-expression (192) — every one is `() => sig.set(x)`, the
//     standard signal-update arrow. The fix is a pair of braces.
//   no-non-null-assertion (131, 120 of them in specs) — downstream of the same
//     `any` the spec block below describes; the `!` becomes load-bearing the
//     moment that `any` is typed.
//   restrict-template-expressions (106 under strict, 1 under recommended) —
//     the whole difference is strict withdrawing `allowNumber`. Printing a
//     number in a template is not a defect.
//   no-unnecessary-condition (55) — it trusts casts the code makes
//     defensively: `describe(error: unknown)` casts to `HttpErrorResponse` and
//     then guards `response?.status`, and the rule calls that guard redundant
//     because the cast told it so. The guard is the honest half of the pair.

module.exports = defineConfig([
  {
    // macOS virtiofs periodically drops `foo 2.ts` copies next to `foo.ts` in
    // the bind mount. They are untracked, stale, and would otherwise fail the
    // lint with findings that were fixed in the real file.
    ignores: ['**/* [0-9].ts', '**/* [0-9].html'],
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      // Type-aware since 2026-08-24. `recommendedTypeChecked` and not
      // `strictTypeChecked`: both were measured on this tree (344 findings vs
      // 894), and the four rules that account for 570 of strict's extra are
      // turned down by name at the bottom of this block, each with what it
      // actually fires on here rather than a count.
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    languageOptions: {
      // `projectService` and not `project: [...]`: the tsconfig here is
      // solution-style (`files: []` + references), so each file is resolved to
      // whichever of `tsconfig.app.json` / `tsconfig.spec.json` actually
      // includes it. A hardcoded list would have to be kept in step with both.
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: ['app', 'zen'], style: 'camelCase' },
      ],

      // ── Turned off, with the reason each one earns ────────────────────────
      //
      // Its fix is a behaviour change here, not a cleanup. Measured: 19 sites,
      // and 18 of them are `serverMessage || 'friendly fallback'`, where `??`
      // hands the user a *blank* error the moment the server sends an empty
      // string, or `a.width || 2`, where `??` keeps a zero-width stroke. `||`
      // is the operator those sites mean.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',

      // Specs reach protected members on purpose — `fixture.componentInstance
      // ['registerLinkParams']()` is the only way to read one — and TypeScript
      // will not let them use a dot. The bracket is the workaround, not a
      // smell.
      '@typescript-eslint/dot-notation': [
        'error',
        { allowProtectedClassPropertyAccess: true },
      ],
    },
  },
  {
    // Angular types its own test surfaces `any` — `ComponentFixture
    // .nativeElement`, `DebugElement.nativeElement` and `TestRequest.request
    // .body` — so the unsafe-* family fires on *correct* test code with
    // nothing at the call site to fix. Measured 2026-08-24: 199 unsafe-*
    // findings across 29 spec files, and all 199 trace to one of those three
    // (126 / 6 / 67). `no-unnecessary-type-assertion` goes with them because
    // its 39 findings are the same root cause seen from the other end — every
    // one is a `!` that is "unnecessary" only because the value is already
    // `any`, and deleting them would delete assertions that become necessary
    // again the moment Angular types those APIs.
    //
    // This is the relaxation, and it stops here: `no-floating-promises`,
    // `no-misused-promises` and `await-thenable` stay on in specs, because
    // those fire on the test, not on Angular.
    files: ['src/**/*.spec.ts', 'src/app/testing/**/*.ts', 'src/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // `const realCreate = URL.createObjectURL` — saved to be restored in an
      // `afterEach`, never called unbound. The rule cannot tell the two apart.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Components only. Facades and services under `abstraction/` and `core/`
    // are `providedIn: 'root'` — they live as long as the app does, so there is
    // no destruction for a subscription to be tied to, and `DestroyRef` there
    // would be a lie. Specs subscribe to outputs on purpose.
    files: ['src/app/features/**/*.ts', 'src/app/shared/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    plugins: { zen: { rules: { 'subscriptions-die-with-the-component': subscriptionsDieWithTheComponent } } },
    rules: { 'zen/subscriptions-die-with-the-component': 'error' },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {},
  },
]);
