# Suites and when they run

| Suite | Command | Runs | Takes |
|---|---|---|---|
| Backend | `docker compose run --rm -e DJANGO_SETTINGS_MODULE=config.settings.test api pytest -q` | every commit | ~2 min |
| Frontend unit | `docker compose run --rm --no-deps web npx ng test --watch=false` | every commit | ~30 s |
| `@smoke` | `cd e2e && npx playwright test --grep @smoke` | every deploy, against the deployed host | ~30 s |
| Full e2e | `./infra/test.sh --e2e` | every commit to `main` | ~4 min |
| Cross-browser | `cd e2e && BROWSERS=all npx playwright test` | nightly | ~15 min |

## The flake policy

**Zero retries, deliberately.** A test that passes on the second attempt is
telling you something about the product, and a retry count is how that stops
being heard.

When a spec flakes: reproduce it with `--repeat-each=5`, fix the cause, and if
it cannot be fixed the same day, tag it `@quarantine` (excluded from the deploy
gate) with a dated comment saying why. A quarantine older than one phase is a
bug nobody owns.

## Before tagging a release

- [ ] Full e2e green three consecutive runs on the prod-shaped stack.
- [ ] `@smoke` green against the deployed host.
- [ ] `pip-audit` and `npm audit` reviewed — see `docs/ops/deploy.md`.
- [ ] `PROGRESS.md` updated, and the launch checklist has no unticked owner item.
