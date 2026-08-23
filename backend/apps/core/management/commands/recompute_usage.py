"""Reconcile `storage_bytes_used` by hand (§15, `apps.core.tasks.usage_recompute`).

    python manage.py recompute_usage                    # report only
    python manage.py recompute_usage --principal <uuid> # one account or session
    python manage.py recompute_usage --apply            # write the corrections

**Dry run is the default, and `--apply` is the only thing that writes.** That is
the opposite of the beat task, which heals unattended — deliberately. A wrong
recompute is a wrong quota for *every* user at once: too low and people are
locked out of storage they are paying nothing for anyway, too high and the
product gives away the one resource it meters. When a human runs this it is
usually because something already looks wrong, and the first thing they need is
the number, not the write. `--dry-run` is accepted so a script can say what it
means; passing both it and `--apply` is an error rather than a guess.
"""
from django.core.management.base import BaseCommand, CommandError

from apps.core.tasks import usage_recompute


class Command(BaseCommand):
    help = ("Recompute storage_bytes_used from the versions, assets and exports "
            "actually charged. Reports by default; --apply writes.")

    def add_arguments(self, parser):
        parser.add_argument(
            "--principal", default="",
            help="A single User or GuestSession id (both are UUIDs; the "
                 "account is tried first).")
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Report without writing. This is the default; the flag exists "
                 "so a caller can be explicit.")
        parser.add_argument(
            "--apply", action="store_true",
            help="Write the corrected counters. Without this nothing changes.")

    def handle(self, *args, **options):
        if options["apply"] and options["dry_run"]:
            raise CommandError("--apply and --dry-run contradict each other.")
        dry_run = not options["apply"]

        stats = usage_recompute(principal=options["principal"], dry_run=dry_run)

        if not stats["checked"]:
            self.stdout.write("No principal matched.")
            return

        drifts = [d for d in stats["drifts"] if not d.get("skipped")]
        skipped = [d for d in stats["drifts"] if d.get("skipped")]

        if drifts:
            self.stdout.write(f"{'principal':44} {'before':>14} {'after':>14} {'drift':>14}")
            for row in sorted(drifts, key=lambda r: abs(r["drift"]), reverse=True):
                self.stdout.write(
                    f"{row['kind']}:{row['id']:<40} "
                    f"{row['before']:>14,} {row['after']:>14,} {row['drift']:>+14,}"
                )
        for row in skipped:
            self.stdout.write(f"skipped {row['kind']}:{row['id']} — {row['skipped']}")

        verdict = "would be corrected" if dry_run else "corrected"
        self.stdout.write(
            f"\nChecked {stats['checked']} principal(s); {stats['healed']} "
            f"{verdict}; {stats['skipped']} skipped; "
            f"net {stats['drift_bytes']:+,} bytes."
        )
        if dry_run and stats["healed"]:
            self.stdout.write(self.style.WARNING(
                "Nothing was written. Re-run with --apply to correct these."))
