"""Report accounts using an unusual amount of storage (§9B "storage hygiene").

A *report*, not an action. Nothing is deleted, nothing is disabled: the point
is to give a human the shortlist, because the failure mode of an automatic
answer here is deleting somebody's real work. v1 has no dormant-account
auto-delete for the same reason — the policy is documented in
`docs/09-storage-hygiene.md` and applied by hand.

    python manage.py oversized_accounts --over 80

Prints one line per account over the threshold (as a percentage of its tier
quota), largest first, with the numbers a decision needs: what they are using,
what they are allowed, when they last did anything.
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db.models import Max

from apps.core import limits as L


class Command(BaseCommand):
    help = "List accounts using more than --over percent of their storage quota."

    def add_arguments(self, parser):
        parser.add_argument("--over", type=float, default=80.0,
                            help="Percent of quota (default: 80).")
        parser.add_argument("--limit", type=int, default=50,
                            help="How many rows to print (default: 50).")

    def handle(self, *args, **options):
        threshold = options["over"] / 100.0
        rows = []
        users = (get_user_model().objects
                 .annotate(last_document=Max("documents__updated_at"))
                 .order_by("-storage_bytes_used"))
        for user in users.iterator():
            quota = L.for_principal(user).storage_bytes
            if not quota:
                continue
            ratio = user.storage_bytes_used / quota
            if ratio < threshold:
                # The queryset is ordered by usage, but the quota is per tier,
                # so a smaller account on a smaller tier can still be over.
                continue
            rows.append((ratio, user, quota))

        rows.sort(key=lambda row: row[0], reverse=True)
        if not rows:
            self.stdout.write("No account is over that threshold.")
            return

        self.stdout.write(f"{'account':40} {'used':>10} {'quota':>10} {'%':>6}  last activity")
        for ratio, user, quota in rows[: options["limit"]]:
            last = user.last_document.date() if user.last_document else "never"
            self.stdout.write(
                f"{user.email[:40]:40} "
                f"{user.storage_bytes_used // 1048576:>8} MB "
                f"{quota // 1048576:>8} MB "
                f"{ratio * 100:>5.0f}%  {last}"
            )
        self.stdout.write(f"\n{len(rows)} account(s) over {options['over']:.0f}%.")
