"""The certificate of completion (phase-08 §8B step 5).

A one- or two-page PDF that answers, on paper, the question a completed
document raises: *who signed this, when, from where, and is this the file they
signed?* It is generated with reportlab and stored beside the sealed document.

Every fact on it comes from the hash chain, and the chain head is printed at
the bottom — so the certificate is checkable against the record rather than
merely consistent with it.
"""
from __future__ import annotations

import io

from django.conf import settings
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .models import verify_chain

INK = colors.HexColor("#0f172a")
MUTED = colors.HexColor("#64748b")
RULE = colors.HexColor("#cbd5e1")


def _styles():
    base = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle("h1", parent=base["Title"], fontSize=18, leading=22,
                             textColor=INK, alignment=0, spaceAfter=2),
        "sub": ParagraphStyle("sub", parent=base["Normal"], fontSize=9,
                              leading=12, textColor=MUTED),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontSize=11,
                             leading=14, textColor=INK, spaceBefore=10,
                             spaceAfter=4),
        "body": ParagraphStyle("body", parent=base["Normal"], fontSize=9,
                               leading=12, textColor=INK),
        "mono": ParagraphStyle("mono", parent=base["Normal"], fontSize=7.5,
                               leading=10, fontName="Courier", textColor=MUTED),
    }


def _fmt(dt) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC") if dt else "—"


def _table(rows, widths, styles_extra=()):
    table = Table(rows, colWidths=widths, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, RULE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.25, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        *styles_extra,
    ]))
    return table


def build(sign_request) -> bytes:
    """Render the certificate. Returns PDF bytes."""
    style = _styles()
    chain = verify_chain(sign_request)
    recipients = list(sign_request.recipients.all())
    events = list(sign_request.audit_events.all())

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=16 * mm, bottomMargin=16 * mm,
        title=f"Certificate of completion — {sign_request.envelope_code}",
        author="ZenPDF",
    )

    story = [
        Paragraph("Certificate of completion", style["h1"]),
        Paragraph(
            f"Envelope {sign_request.envelope_code} · "
            f"generated {_fmt(sign_request.completed_at)}", style["sub"]),
        Spacer(1, 10),
    ]

    owner = sign_request.owner
    owner_name = (getattr(owner, "display_name", "") or "").strip() or owner.email
    story += [
        Paragraph("Document", style["h2"]),
        _table([
            ["Title", sign_request.title],
            ["Sent by", f"{owner_name} <{owner.email}>"],
            ["Sent", _fmt(sign_request.sent_at)],
            ["Completed", _fmt(sign_request.completed_at)],
            ["Fingerprint (SHA-256)", sign_request.final_sha256 or "—"],
        ], [38 * mm, 136 * mm], [("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                                 ("LINEBELOW", (0, 0), (-1, 0), 0, RULE),
                                 ("FONTNAME", (1, 4), (1, 4), "Courier")]),
        Paragraph(
            "The fingerprint identifies the exact file this certificate "
            "describes. A file whose fingerprint differs is a different file.",
            style["sub"]),
    ]

    story += [Paragraph("Signers", style["h2"])]
    rows = [["Name", "Email", "Role", "Consented", "Completed", "IP"]]
    for r in recipients:
        rows.append([
            Paragraph(r.name or "—", style["body"]),
            Paragraph(r.email, style["body"]),
            r.get_role_display(),
            _fmt(r.consent_at),
            _fmt(r.completed_at),
            r.consent_ip or "—",
        ])
    story.append(_table(rows, [26 * mm, 44 * mm, 18 * mm, 32 * mm, 32 * mm, 22 * mm]))

    agents = [(r.email, r.consent_user_agent) for r in recipients
              if r.consent_user_agent]
    if agents:
        story.append(Spacer(1, 4))
        for email, agent in agents:
            story.append(Paragraph(f"{email} — {agent}", style["mono"]))

    story += [Paragraph("Event log", style["h2"])]
    log_rows = [["When (UTC)", "Event", "Who", "IP", "Detail"]]
    for event in events:
        who = event.recipient.email if event.recipient else "—"
        detail = ", ".join(f"{k}={v}" for k, v in (event.metadata or {}).items())
        log_rows.append([
            _fmt(event.created_at).replace(" UTC", ""),
            event.get_type_display(),
            Paragraph(who, style["body"]),
            event.ip or "—",
            Paragraph(detail[:160], style["body"]),
        ])
    story.append(_table(log_rows, [30 * mm, 24 * mm, 42 * mm, 22 * mm, 56 * mm]))

    story += [
        Spacer(1, 8),
        Paragraph("Integrity", style["h2"]),
        Paragraph(
            "Each event above carries the hash of the one before it. "
            f"{'The chain verifies.' if chain['intact'] else 'THE CHAIN DOES NOT VERIFY.'} "
            f"Chain head:", style["body"]),
        Paragraph(chain.get("head") or "—", style["mono"]),
        Spacer(1, 6),
        Paragraph(
            "This document was signed electronically through ZenPDF. The "
            "completed file carries a platform seal; any change to it after "
            "completion invalidates that seal. This is a simple electronic "
            "signature (SES) with a platform seal — not a qualified electronic "
            "signature. Verify a copy at "
            f"{settings.FRONTEND_BASE_URL}/verify.", style["sub"]),
    ]

    doc.build(story)
    return buffer.getvalue()
