"""M2 — the per-document lock (§11, §12).

Two bugs in one context manager:

1. `acquire()` returning False fell through into the body. Only the *release*
   was guarded, so a wait that timed out gave us two writers in the critical
   section rather than one refusal — a lost update on the version chain, which
   is the one structure in the product that is supposed to be append-only.
2. The blocking wait and the lock's TTL were the same 120 s number, so an op on
   the heavy lane (900 s hard limit) outlived the lock protecting it. The
   second half of a long redaction ran unprotected by construction.

The suite is hermetic — no Redis (§18) — so these drive `doc_lock` against a
recording double and assert on what it asks Redis for.
"""
import pytest
from django.conf import settings
from django.test import override_settings

from apps.documents.tasks import doc_lock
from apps.pdf_engine.exceptions import EngineError


class FakeLock:
    def __init__(self, name, **kwargs):
        self.name = name
        self.kwargs = kwargs
        self.acquired = False
        self.released = False

    def acquire(self):
        self.acquired = self.kwargs.pop("_grant", True)
        return self.acquired

    def release(self):
        self.released = True


class FakeRedis:
    def __init__(self, grant=True):
        self.grant = grant
        self.last: FakeLock | None = None

    def lock(self, name, **kwargs):
        self.last = FakeLock(name, _grant=self.grant, **kwargs)
        return self.last


@pytest.fixture
def redis_double(monkeypatch):
    """`doc_lock` does `import redis` inside the function, so patch the module."""
    import redis

    made: list[FakeRedis] = []

    def factory(grant=True):
        fake = FakeRedis(grant=grant)
        made.append(fake)
        monkeypatch.setattr(redis, "from_url", lambda *a, **k: fake)
        return fake

    return factory


# The lock only runs for real when Celery is not eager; the hermetic suite is.
not_eager = override_settings(CELERY_TASK_ALWAYS_EAGER=False)


def test_a_writer_that_cannot_acquire_is_refused_rather_than_let_in(redis_double):
    fake = redis_double(grant=False)
    entered = False

    with not_eager, pytest.raises(EngineError) as caught:
        with doc_lock("doc-1"):
            entered = True

    assert entered is False, "the body ran without the lock"
    assert caught.value.code == "locked"
    assert "busy" in caught.value.message
    # Nothing acquired ⇒ nothing released; releasing another holder's lock is
    # the failure mode this must not trade itself for.
    assert fake.last is not None and fake.last.released is False


def test_a_writer_that_acquires_runs_and_releases(redis_double):
    fake = redis_double(grant=True)
    entered = False

    with not_eager:
        with doc_lock("doc-1"):
            entered = True

    assert entered is True
    assert fake.last is not None
    assert fake.last.name == "zen:doc:doc-1"
    assert fake.last.released is True


def test_the_lock_is_released_even_when_the_body_raises(redis_double):
    fake = redis_double(grant=True)

    with not_eager, pytest.raises(ValueError):
        with doc_lock("doc-1"):
            raise ValueError("engine blew up")

    assert fake.last is not None and fake.last.released is True


def test_the_ttl_outlasts_the_heaviest_op_and_the_wait_does_not(redis_double):
    fake = redis_double(grant=True)

    with not_eager:
        with doc_lock("doc-1"):
            pass

    kwargs = fake.last.kwargs
    # §12: the heavy lane's hard limit is 900 s. A lock that expires while its
    # own holder is still working is not a lock.
    assert kwargs["timeout"] >= settings.CELERY_TASK_TIME_LIMIT
    assert kwargs["timeout"] >= 900
    # …and the wait stays the small, separately-tunable number.
    assert kwargs["blocking_timeout"] == settings.DOC_LOCK_TIMEOUT
    assert kwargs["blocking_timeout"] < kwargs["timeout"]


def test_the_ttl_narrows_to_the_lane_the_op_actually_runs_on(redis_double):
    """The TTL is also the wedge a *killed* worker leaves behind.

    Holding every lock for the heavy lane's ceiling means a crashed 60-second
    render costs sixteen minutes of "that document is busy" for an op that
    could never have run that long.
    """
    from apps.documents.tasks import LANE_TIME_LIMITS, lock_ttl_for

    for queue, limit in LANE_TIME_LIMITS.items():
        ttl = lock_ttl_for(queue)
        assert ttl >= limit, f"{queue}'s lock expires under its own op"
        assert ttl <= settings.DOC_LOCK_TTL

    assert lock_ttl_for("render") < lock_ttl_for("default") < lock_ttl_for("heavy")
    # An unknown or absent lane assumes the worst, which is the safe direction.
    assert lock_ttl_for(None) == settings.DOC_LOCK_TTL
    assert lock_ttl_for("something-new") == settings.DOC_LOCK_TTL

    fake = redis_double(grant=True)
    with not_eager:
        with doc_lock("doc-1", queue="render"):
            pass
    assert fake.last.kwargs["timeout"] == lock_ttl_for("render")


def test_the_two_knobs_are_not_the_same_setting():
    """They were, and that is what let an op outlive its own lock."""
    assert settings.DOC_LOCK_TTL >= settings.CELERY_TASK_TIME_LIMIT
    assert settings.DOC_LOCK_TIMEOUT < settings.DOC_LOCK_TTL


@pytest.mark.django_db
def test_a_locked_operation_fails_the_job_with_the_locked_code(user, uploaded_doc,
                                                               redis_double):
    """The refusal has to reach the client as the §6 shape — a code they can
    switch on and a sentence a toast can render — not as a half-run task."""
    from apps.documents.models import Document
    from apps.documents.tasks import run_operation
    from apps.jobs.models import Job

    redis_double(grant=False)
    document = Document.objects.get(id=uploaded_doc["id"])
    job = Job.objects.create(user=user, document=document, type="rotate_pages",
                             params={"pages": [0], "degrees": 90})

    # `apply()` runs the task in-process whatever the eager flag says, which is
    # what lets the lock take its real branch inside a hermetic suite.
    with not_eager:
        run_operation.apply(args=[str(job.id)])

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "locked"
    assert "busy" in job.error_message
    # And the document is exactly where it was — one version, unrotated.
    assert Document.objects.get(id=document.id).versions.count() == 1


@pytest.mark.django_db
def test_revert_reports_the_same_code_rather_than_engine_error(user, uploaded_doc,
                                                               redis_double):
    """`revert_version` had no `except EngineError` at all.

    It did not matter while nothing in its path raised one. It matters now that
    two things do — this lock, and the tier page cap on the version write — and
    without the branch both arrive as `engine_error: Revert failed: …`, which is
    neither a code the client can switch on nor a sentence anybody can act on.
    """
    from apps.documents.models import Document
    from apps.documents.tasks import revert_version
    from apps.jobs.models import Job

    redis_double(grant=False)
    document = Document.objects.get(id=uploaded_doc["id"])
    job = Job.objects.create(user=user, document=document, type="revert_version",
                             params={"seq": 1})

    with not_eager:
        revert_version.apply(args=[str(job.id)])

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "locked", job.error_message
    assert "Revert failed" not in job.error_message
    assert Document.objects.get(id=document.id).versions.count() == 1
