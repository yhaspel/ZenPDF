"""M1 — the address signing evidence attests to (§8, §16).

`esign.models.client_ip` took the *leftmost* X-Forwarded-For hop, which is the
one the client wrote. That value goes into the hash-chained audit trail, into
`recipient.consent_ip`, and onto the certificate of completion — so a signer
could choose the address their own consent record says they signed from, and
the intact chain around it would make the lie look checked.

The core helper (`apps.core.authentication.client_ip`) counts back
`NUM_PROXIES` hops from the end, which is the address our own proxy appended.
These tests drive the three writing paths with a spoofed prefix and assert none
of them believes it.
"""
import pytest
from django.core import mail

from apps.esign.models import AbuseReport, AuditEvent, Recipient

pytestmark = pytest.mark.django_db

SPOOF = "1.2.3.4"           # what the signer claims, ahead of the real chain
REAL = "203.0.113.9"        # what our own proxy appended
CHAIN = f"{SPOOF}, {REAL}"  # NUM_PROXIES=1 ⇒ the right answer is REAL


@pytest.fixture(autouse=True)
def _verified(user):
    user.email_verified = True
    user.save(update_fields=["email_verified"])
    return user


@pytest.fixture
def sent(api, uploaded_doc):
    """One signer, one signature field, request sent."""
    created = api.post("/api/sign-requests/",
                       {"document": uploaded_doc["id"], "title": "Offer"},
                       format="json")
    assert created.status_code == 201, created.content
    request_id = created.json()["id"]
    people = api.patch(f"/api/sign-requests/{request_id}/",
                       {"recipients": [{"email": "signer@example.com",
                                        "name": "Sam", "role": "signer",
                                        "order": 1}]},
                       format="json").json()["recipients"]
    api.patch(f"/api/sign-requests/{request_id}/",
              {"fields": [{"recipient_id": people[0]["id"], "page": 0,
                           "x": 0.1, "y": 0.7, "w": 0.3, "h": 0.08,
                           "type": "signature", "required": True,
                           "label": "Sign here"}]}, format="json")
    mail.outbox.clear()
    assert api.post(f"/api/sign-requests/{request_id}/send/",
                    format="json").status_code == 200
    return Recipient.objects.get(sign_request_id=request_id,
                                 email="signer@example.com")


def test_consent_records_the_proxy_derived_address(anon, sent):
    resp = anon.post(f"/api/public/sign/{sent.token}/consent/", {"agree": True},
                     format="json", HTTP_X_FORWARDED_FOR=CHAIN,
                     REMOTE_ADDR="10.0.0.9")
    assert resp.status_code == 200, resp.content

    sent.refresh_from_db()
    assert sent.consent_ip == REAL
    assert sent.consent_ip != SPOOF


def test_the_audit_chain_records_the_proxy_derived_address(anon, sent):
    anon.post(f"/api/public/sign/{sent.token}/consent/", {"agree": True},
              format="json", HTTP_X_FORWARDED_FOR=CHAIN, REMOTE_ADDR="10.0.0.9")

    event = AuditEvent.objects.filter(recipient=sent, type="consented").get()
    assert str(event.ip) == REAL


def test_an_abuse_report_records_the_proxy_derived_address(anon, sent):
    resp = anon.post(f"/api/public/sign/{sent.token}/report/",
                     {"reason": "I never asked for this"}, format="json",
                     HTTP_X_FORWARDED_FOR=CHAIN, REMOTE_ADDR="10.0.0.9")
    assert resp.status_code in (200, 201), resp.content

    report = AbuseReport.objects.get(recipient=sent)
    assert str(report.ip) == REAL


def test_a_direct_peer_with_no_forwarding_header_is_still_recorded(anon, sent):
    """The fallback has to keep working, or the fix trades one hole for a gap."""
    resp = anon.post(f"/api/public/sign/{sent.token}/consent/", {"agree": True},
                     format="json", REMOTE_ADDR="198.51.100.77")
    assert resp.status_code == 200, resp.content

    sent.refresh_from_db()
    assert sent.consent_ip == "198.51.100.77"


def test_no_address_at_all_stores_null_rather_than_an_empty_string(sent):
    """`AuditEvent.ip` is a nullable GenericIPAddressField; `""` is not a valid
    value for one, and the core helper returns `""` when it has nothing."""
    from django.test import RequestFactory

    from apps.esign.models import client_ip

    request = RequestFactory().post("/")
    request.META.pop("REMOTE_ADDR", None)
    assert client_ip(request) is None
