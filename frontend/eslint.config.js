// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');
const subscriptionsDieWithTheComponent =
  require('./tools/eslint-rules/subscriptions-die-with-the-component');

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
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: ['app', 'zen'], style: 'camelCase' },
      ],
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
