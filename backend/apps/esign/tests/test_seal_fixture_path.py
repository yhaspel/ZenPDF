"""Where the test suite looks for the development signing certificate.

`SIGNING_CERT_PATH` defaults to `/certs/zenpdf-dev.p12` — a Docker mount that
exists inside compose and nowhere else. Outside it, fourteen e-signature and
isolation tests failed with what looked like seal breakage: the worst possible
symptom for a path problem, and one that had been re-diagnosed more than once
before anyone noticed that setting the variable made all sixty-two pass.

`up.sh` writes the same certificate to `infra/certs/`, so the repo carries a
copy. These tests pin the four behaviours of the resolver that decide whether
the next such run is debugged or misdiagnosed.

The filesystem is simulated rather than consulted, deliberately: a test that
asked the real one would assert something different inside compose (where the
mount is present) than outside it (where it is not), and would therefore prove
nothing in either place.
"""
from pathlib import Path

from django.conf import settings

from config.settings.test import _resolve_signing_cert

COMPOSE_PATH = "/certs/zenpdf-dev.p12"


def repo_copy() -> Path:
    return settings.BASE_DIR.parent / "infra" / "certs" / "zenpdf-dev.p12"


def only_these_exist(*present: str):
    """A `Path.exists` that answers True for exactly the given paths."""
    wanted = {str(p) for p in present}
    return lambda self: str(self) in wanted


def test_the_compose_mount_wins_when_it_is_there(monkeypatch):
    """Inside compose nothing changes — this is the common case."""
    monkeypatch.delenv("SIGNING_CERT_PATH", raising=False)
    monkeypatch.setattr(Path, "exists", only_these_exist(COMPOSE_PATH, repo_copy()))
    assert _resolve_signing_cert(COMPOSE_PATH) == COMPOSE_PATH


def test_the_repo_copy_is_used_when_the_mount_is_absent(monkeypatch):
    """The case this exists for: a sandbox or CI runner with no /certs mount."""
    monkeypatch.delenv("SIGNING_CERT_PATH", raising=False)
    monkeypatch.setattr(Path, "exists", only_these_exist(repo_copy()))
    assert _resolve_signing_cert(COMPOSE_PATH) == str(repo_copy())


def test_an_explicit_setting_is_never_overridden(monkeypatch):
    """Somebody who names a certificate means that certificate."""
    monkeypatch.setenv("SIGNING_CERT_PATH", "/somewhere/else.p12")
    monkeypatch.setattr(Path, "exists", only_these_exist(repo_copy()))
    assert _resolve_signing_cert("/somewhere/else.p12") == "/somewhere/else.p12"


def test_with_neither_path_present_the_error_still_names_the_mount(monkeypatch):
    """A missing certificate must fail by its real name.

    Silently substituting a path the reader has never seen turns "the mount is
    not there" into "why is it looking in infra/certs?" — the resolver keeps the
    compose default so the failure message is the one that helps.
    """
    monkeypatch.delenv("SIGNING_CERT_PATH", raising=False)
    monkeypatch.setattr(Path, "exists", only_these_exist())
    assert _resolve_signing_cert(COMPOSE_PATH) == COMPOSE_PATH


def test_the_setting_in_force_points_at_a_certificate_that_is_there(monkeypatch):
    """Whatever the resolution, the suite must have a certificate to seal with.

    Not a tautology: this is the assertion that fails first, with a readable
    message, if both the mount and the repo copy have gone — instead of
    fourteen tests failing later as if the seal itself were broken.
    """
    assert Path(settings.SIGNING_CERT_PATH).exists(), (
        f"no signing certificate at {settings.SIGNING_CERT_PATH}. Inside compose "
        "that is the /certs mount; outside it, run ./infra/up.sh, which "
        "generates infra/certs/zenpdf-dev.p12."
    )
