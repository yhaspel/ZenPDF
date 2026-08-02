# ZenPDF — what each tool does, and where it stops

Written to be honest about limits rather than to sell. Every tool below works
**without an account**; what an account adds is a library that does not expire,
a place to keep a signature, and the ability to send a document to somebody
else for signature.

Files uploaded without an account are deleted within 24 hours. Trash is emptied
after 30 days. Exports are kept for 24 hours.

## Pages

**Merge, split, extract, delete, reorder, rotate, crop, scale, N-up, insert
blank.** Lossless: pages are moved, never re-encoded, so nothing degrades.
Crop is a *visual* crop — the content outside the box is hidden by the page
box, not removed. Use redaction if the point is that nobody can recover it.

**Compress.** Re-encodes images and drops unused objects. The "strong" preset
visibly softens photographs; "light" is safe for text documents. A PDF that is
already efficient will barely shrink — that is the file being fine, not the
tool failing.

## Annotate

Highlight, underline, strike, notes, shapes, freehand, text boxes, stamps.
These are real PDF annotations, so any viewer can see them and Acrobat can
edit them. **Flatten** burns them into the page when you want them
un-editable.

## Edit text and images

Real text editing, with one honest limit: the replacement font is a
*substitute* whenever the original is subsetted, which it usually is. Body
text in a common font looks right; a display or branded font will visibly
differ. Edits are scoped to the block you touched, so the damage of a bad
substitution stays local. If exact fidelity matters, edit the source document
and re-export.

**A scanned page has no text to edit.** The editor says so and offers OCR,
which is the actual fix.

## OCR

Makes a scan searchable and selectable. Five languages including Hebrew.
Accuracy depends entirely on the scan: clean 300 dpi text is near-perfect,
a phone photo of a curled receipt is not. Tables come back as text in reading
order, not as a table. OCR never changes what the page *looks* like — it adds
an invisible text layer beneath it.

## Convert

**To PDF** from Word, Excel, PowerPoint, images, HTML and web pages.
**From PDF** to Word, images, text, Markdown, HTML and PDF/A.

PDF → Word is a *reconstruction*, and the more the layout relies on absolute
positioning, the more it will differ. PDF/A output claims conformance because
Ghostscript produced it and the marker is present; we do not run full veraPDF
validation, and the tool page says so.

## Compare

Text differences and visual differences between two documents, side by side.
The visual pass samples an 8-pixel grid: a change invisible at that size is
invisible to a reader too. Regions smaller than 0.02% of the page are ignored,
because anti-aliasing otherwise produces a scatter of meaningless boxes.

## Forms

Fill existing form fields, or build new ones. Filled values can be flattened so
they cannot be changed. XFA forms (an old Adobe format) are not supported —
we say so rather than producing a file that looks filled and is not.

## Protect, unlock, redact, sanitize

**Protect** applies AES-256 with separate user and owner passwords, and graded
permissions. Accessibility is never restricted, whatever else is.

**Editing an unlocked document removes its password**, and the app says so
before you act and labels the version afterwards. Neither password is
recoverable from the other, so re-applying protection faithfully is not
possible — we would rather tell you than guess.

**Redact** removes content, it does not cover it: the text is gone from the
file's bytes, and pixels under a redacted area of an image are destroyed. The
default is to work on a clean copy, so the original's history cannot leak.
Review each match before applying — pattern matching finds things that look
like a card number and misses things that do not.

**Sanitize** removes JavaScript, embedded files, metadata and comments, and
reports exactly what it removed.

## Sign

**Sign it yourself** — draw, type or upload a signature, place it, done. Works
without an account.

**Send it to other people** — needs an account with a confirmed email address,
because every invitation is sent in your name. Recipients sign in the order you
set, get reminders, and can decline or report a request they did not expect.
The finished document is sealed with a document signature and accompanied by a
certificate listing every event with its timestamp, IP and user agent, chained
so that altering one entry invalidates the rest.

**What this is, precisely:** a simple electronic signature with a platform
seal, valid under ESIGN and eIDAS as a SES. It is **not** a qualified
electronic signature (QES) — that needs identity verification we do not do.
The disclosure says this in as many words before anybody signs.

**Verify** at `/verify`: upload any PDF and it reports whether the signature is
intact, whether the whole document is covered, and whether anything was
appended after signing.

## What we do not do

Batch pipelines, teams and sharing, templates, a public API, PDF → Excel,
booklet imposition, threaded comments. Those are on the roadmap, not hidden
behind a paywall.
