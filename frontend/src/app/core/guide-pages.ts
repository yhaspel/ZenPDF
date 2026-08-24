import { ToolKind } from './tool-pages';

/**
 * The guide route table (01-architecture.md §21.6, phase-11 §11C).
 *
 * The editorial layer, and it is a **static table in `core/`, exactly like
 * `tool-pages.ts`** — deliberately not a CMS. No comments, no tags, no RSS, no
 * pagination, no draft state; the set grows by editing this file and shipping.
 * `sitemap.xml` is generated from it (priority 0.6, under `guides/`), the
 * routes are generated from it in both route files, and
 * `tools/verify-prerender.mjs` asserts every slug here came out of the build
 * with its own `<title>`, its H1, a canonical and `Article` JSON-LD.
 *
 * **Why prose pages exist at all.** The tool pages are widgets that happen to
 * carry copy; nothing on the site had *prose* as its primary content, and that
 * absence is what AdSense's "low value content" rejections are made of. The
 * counter is a small number of genuinely good pages, not a large number of
 * thin ones — which is what the floors in `guide-pages.spec.ts` are for.
 *
 * **Every factual claim here was checked against the running system**, not
 * remembered: guest and account limits from `config/settings/base.py` `TIERS`,
 * retention from `core/retention.ts`, OCR languages from `engine/ocr.py`,
 * compression presets from `engine/pages.py`, redaction from `engine/redact.py`,
 * encryption from `engine/security.py`, flattening from
 * `engine/annotations.py`, conversion from `engine/convert.py`, stamping from
 * `engine/content.py`, and the e-signature claims from `apps/esign/legal.py`
 * and `engine/seal.py`. A guide that describes a feature we do not have is a
 * dead affordance in prose.
 *
 * Slug lines are formatted `  slug: 'the-slug',` so `extractSlugs()` in
 * `tools/seo.mjs` parses this file with no change — the same trick that keeps
 * the tool table and the sitemap from drifting.
 */
export interface GuideSection {
  /** Rendered as an `<h2>`. The opening section usually has none. */
  heading?: string;
  paragraphs: string[];
  /**
   * A standing caution, rendered as the design contract's `.notice`
   * (`.notice-info`) at the end of the section it belongs to — §4 says it sits
   * where the caution applies, not stacked at the top of the page.
   *
   * The optional `link` is inside the notice on purpose: §3 says the actions a
   * notice refers to sit within it, "so the explanation and the way out are
   * one object". It is also the only inline link a guide can have — the prose
   * is plain text bound with `{{ }}`, deliberately, because a guide table that
   * carried markup would be a guide table that could carry anything.
   */
  note?: {
    text: string;
    link?: { href: string; label: string };
  };
}

export interface GuidePageDef {
  slug: string;
  /** Unique `<title>`. */
  title: string;
  /**
   * Doubles as the one-line description on `/guides`. One string rather than
   * two: a separate `summary` would say the same thing in almost the same
   * words and drift from it within a year.
   */
  metaDescription: string;
  h1: string;
  /** Fixed ISO dates — prerender output has to be byte-deterministic. */
  published: string;
  updated: string;
  sections: GuideSection[];
  /** Rendered as the landing directory's tool cards, and validated to resolve. */
  relatedTools: ToolKind[];
}

export const GUIDE_PAGES: GuidePageDef[] = [
  {
    slug: 'how-to-merge-pdf-files',
    title: 'How to merge PDF files: order, batches and what gets lost | ZenPDF',
    metaDescription:
      'How merging a PDF actually works: how page order is decided, what happens to bookmarks and links, and how to combine more files than one pass allows.',
    h1: 'How to merge PDF files',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'Merging is the most ordinary thing anyone does to a PDF, and it is also the operation people most often discover has quietly done something they did not want. The joining itself is simple. What is worth understanding is what the result inherits from its sources, what it does not, and how the order gets decided — because all three are invisible until you open the file and find a chapter in the wrong place.',
          'This guide covers the mechanics rather than the clicking. If you only want the tool, it is on the merge page and it needs no account.',
        ],
      },
      {
        heading: 'Order follows the order you added the files',
        paragraphs: [
          'Every merge tool has to decide what "first" means, and the answers differ. Some sort alphabetically by filename. Some use the order the files finished uploading, which on a real connection means a small cover page can overtake a large scanned chapter and land in front of it. ZenPDF uses the order you added the files, and holds that order all the way through the upload, precisely because the alternative is a result that changes depending on your network.',
          'That matters most when the filenames do not sort the way the document reads. Chapters named "1", "2" … "10" sort as 1, 10, 2 under an alphabetical rule. Scanner output named by timestamp sorts correctly only if the scanning happened in reading order, which it often did not. If you are relying on a sort you cannot see, you are relying on luck.',
          'If the order is wrong afterwards, you do not have to merge again. Open the result in the workspace and reorder the pages there by dragging them — that is a different operation with a different guarantee, and it is the right one for arranging pages rather than files.',
        ],
      },
      {
        heading: 'What does not survive a merge',
        paragraphs: [
          'A merged PDF gets a fresh, flat structure. Bookmarks — the outline pane your reader shows down the side — are not carried across from the source files, and neither are internal links that pointed from one page to another inside a source document. This is worth planning for rather than discovering: if you are assembling a 400-page report out of twelve chapter files, each with its own outline, the merged file will open with no outline at all.',
          'The fix is to rebuild the outline after merging rather than expecting it to survive. That is one deliberate pass over a finished document instead of an outline stitched together out of twelve partial ones, which in practice is also the better outline.',
          'What does survive is everything on the page. Pages are copied across as they are, not re-rendered, so text stays selectable, images keep their original resolution, and nothing is recompressed behind your back. A merged file is roughly the sum of its parts in size, and if that is a problem, compression is a separate step you choose rather than one that happens to you.',
          'Annotations, form fields and existing signatures travel with their pages. That last one has a consequence worth stating plainly: merging a signed document into a larger one breaks the signature on it. The signature was a claim about a specific file, and the merged file is not that file. If a signed document has to end up inside a compilation, keep the signed original separately as the thing that can actually be verified.',
        ],
      },
      {
        heading: 'Limits, batches and encrypted sources',
        paragraphs: [
          'There is no fixed limit on how many files you can combine in one pass, but each file has to fit the per-file limits. Without an account that is 25 MB and 300 pages per file; a free account raises both to 100 MB and 2,000 pages. When you are working with a stack of scanned chapters that individually exceed the limit, the shape of the answer is to merge in batches and then merge the batches — merging is associative, so the result is identical either way.',
          'If one of the sources is password-protected, you will be asked to unlock it before the merge runs. This is deliberate and slightly annoying by design: the alternative is silently skipping a file you explicitly asked to include, and a merged document that is quietly missing a chapter is a worse outcome than an error message. The same applies to a damaged file, which is offered a repair pass on upload rather than being dropped.',
          'Files you merge without an account are deleted automatically within 24 hours, and that clock is on the uploaded sources as well as the result. Download what you need before you close the tab. With an account the result stays in your library until you delete it, which is the practical reason accounts exist here — not a feature gate, just a place to put things.',
        ],
      },
      {
        heading: 'When merging is the wrong tool',
        paragraphs: [
          'Two cases come up often enough to name. The first is combining pages from several documents where you want only some pages from each: merging everything and then deleting pages works, but extracting the pages you want first is fewer steps and produces a smaller intermediate file. The second is interleaving — the classic case being a duplex scan done as two passes, one of odd pages and one of even. That is not a merge; concatenating the two files gives you every odd page followed by every even page. The workspace has an alternate-mix operation for exactly this, and it is the one to reach for.',
        ],
      },
    ],
    relatedTools: ['merge', 'organize', 'split', 'extract-pages'],
  },

  {
    slug: 'compress-pdf-without-losing-quality',
    title: 'Compress a PDF without wrecking it: what actually gets traded | ZenPDF',
    metaDescription:
      'What PDF compression really trades away, why some files barely shrink, and how to tell which of the three presets is the right one for the file in front of you.',
    h1: 'Compressing a PDF without wrecking it',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          '"Compress without losing quality" is the phrase everybody searches for, and it is very nearly a contradiction. A PDF that is large because of its images gets smaller by making those images cheaper to store, and every way of doing that costs something. What varies is how much it costs and whether you can see it — so the useful question is not "will I lose quality" but "where is the size, and what am I willing to trade for it".',
          'This guide explains where the bytes actually are and what each of the three presets does to them, so the choice is an informed one rather than a hopeful one.',
        ],
      },
      {
        heading: 'Where the size actually is',
        paragraphs: [
          'Open a large PDF and there are usually four candidates for the bulk, and they behave completely differently.',
          'Scanned images are the common one. A page scanned at 600 dpi in colour is several megabytes on its own, and a 40-page document of them is a file nobody can email. This is the case compression was built for, and it is where the gains are dramatic.',
          'Embedded fonts are the quiet one. A document can carry a full font file for every typeface it mentions, including the ones used for a single character in a footnote. Subsetting — keeping only the glyphs actually used — often takes a surprising amount off a text-heavy file with no visible change at all, because nothing on the page is altered.',
          'Vector graphics, such as a chart exported from a spreadsheet, are mathematically described rather than stored as pixels. They are usually small, and when they are not it is because they contain tens of thousands of individual paths, which no image compression touches.',
          'And finally, plain accumulated cruft: revision history, deleted objects still present in the file, duplicate resources. This is why a document that has been edited many times can be far larger than one with the same content produced fresh.',
        ],
      },
      {
        heading: 'The three presets, and what each one does',
        paragraphs: [
          'Light does not touch your images at all. It rewrites the file structure — cleaning up unreferenced objects and compressing the internal streams — and that is all. Nothing on any page changes in any way. Use it when the document is text and vector graphics, when it has been through many rounds of editing, or when the file will be printed and you are not prepared to risk anything visible.',
          'Balanced is the default and the one most files want. It re-encodes images at up to about 150 dpi at JPEG quality 75, keeping colour, and it subsets the embedded fonts. On a colour scan this is typically a large reduction; on a text document it is a modest one that comes almost entirely from the fonts. At 150 dpi, printed output is noticeably softer than the original if you look for it, and on screen at normal zoom most people do not.',
          'Strong pushes images down to about 110 dpi at quality 55 and converts them to greyscale. This is a deliberate, visible trade: it makes a colour scan monochrome and it makes fine detail mushy. It exists for the case where the file has to get under a limit and the content is text on paper — a signed contract, a scanned form — where legibility is all that matters and colour was never carrying information.',
        ],
      },
      {
        heading: 'When compression does nothing, and why that is honest',
        paragraphs: [
          'If the result would be less than three per cent smaller than the original, you get your original file back unchanged and a note saying it was already optimised. This is deliberate. A "compression" that shaves half a per cent while re-encoding every image on every page has cost you real image quality in exchange for nothing, and returning a slightly smaller, slightly worse file would be the dishonest outcome that looks like success.',
          'Files that behave this way are usually one of three kinds: already compressed by whatever produced them, born-digital documents that are mostly text and were never big to begin with, or files whose size is in something images are not — an enormous embedded attachment, or a vector drawing with a hundred thousand paths.',
          'It is worth checking what you have before assuming compression is the answer. A 30 MB file that is 29 MB of scanned images will compress beautifully. A 30 MB file that is 29 MB of one embedded video will not compress at all, and the answer there is to remove the attachment.',
        ],
      },
      {
        heading: 'When compression is not enough',
        paragraphs: [
          'If the file still will not fit after the strong preset, stop compressing and change the shape of the problem. Splitting a long document into parts and sending them separately is usually better than crushing all of it — three readable 8 MB files beat one illegible 24 MB one. If the document is a scan of something that is fundamentally text, running OCR and then extracting the text is an option for cases where the recipient needs the words rather than the paper.',
          'One thing not to do: putting a PDF inside a zip archive. PDFs are already internally compressed, so a zip of one is essentially the same size with an extra step for the recipient, and many mail systems are more suspicious of an archive than of the document inside it.',
        ],
      },
    ],
    relatedTools: ['compress', 'split', 'ocr', 'pdf-to-jpg'],
  },

  {
    slug: 'fill-and-sign-pdf-without-printing',
    title: 'Fill and sign a PDF without printing it | ZenPDF',
    metaDescription:
      'The print-sign-scan cycle is avoidable. How to tell a real PDF form from a flat one, how to fill each, and how to sign the result and send it so it stays as you left it.',
    h1: 'Filling and signing a PDF without printing it',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'The print-sign-scan cycle survives mostly out of habit. It produces a worse document than the one you started with — crooked, greyer, several times the size, and no longer searchable — and it takes twenty minutes and a printer you may not have. Nearly every form can be completed and signed without any of it.',
          'The first thing to work out is which of two quite different situations you are in, because the answer changes what you do next.',
        ],
      },
      {
        heading: 'Two kinds of PDF that look identical',
        paragraphs: [
          'A real PDF form has form fields in it: named boxes the document itself declares, which a reader knows how to focus and type into. Click near a blank in one of these and you get a cursor. These are what banks, tax authorities and HR departments usually send, and they are the pleasant case.',
          'A flat PDF has no fields at all. The lines and boxes you see are drawn on the page, exactly like the rest of the design. Click on one and nothing happens, because there is nothing there to click. Anything scanned is flat by definition, and so is anything exported from a design tool by someone who did not think about it.',
          'The test takes a second: click where you would write. A cursor means fields; no cursor means no fields. Both are fillable here, but by different routes.',
        ],
      },
      {
        heading: 'Filling a real form',
        paragraphs: [
          'If the document has fields, use them. The values are written into the PDF\'s own form fields, so every conforming reader — Acrobat, Preview, a browser, whatever the recipient happens to open it in — shows what you typed, in the right place, at the right size. Text fields, checkboxes, radio groups and dropdowns all work the way the document\'s author intended.',
          'There is a real advantage beyond convenience: the values stay data rather than becoming ink. You can export what you filled in as JSON or CSV and import it back into the same form later, or into next year\'s copy of it. If you complete the same thirty-field form every quarter, that is the difference between a task and a keystroke.',
          'One kind of form will refuse to cooperate, and it is worth naming so you do not blame yourself. XFA forms — a format from Adobe\'s LiveCycle era, occasionally still emitted by government systems — are not really PDF forms at all; they are an XML application wearing a PDF wrapper. These are detected and you are told, rather than being shown a half-rendered document that silently drops what you type.',
        ],
      },
      {
        heading: 'Filling a flat one',
        paragraphs: [
          'If there are no fields, you add text to the page yourself. Place a text box where the answer goes, type, and adjust the size so it sits on the line rather than through it. It is slower than tabbing between real fields, and it is still far quicker than printing.',
          'Two things make the result look intentional rather than improvised. Match the text size to the surrounding print rather than leaving it at whatever the default was — a form filled in 18-point type over 9-point labels reads as a mistake. And keep a consistent baseline down the page, because the eye notices a wandering one immediately even when it cannot say why.',
          'If you find yourself doing this to the same document repeatedly, it is worth building real fields on it once. That turns a flat form into a proper one you can complete by typing, and it is a one-time cost you recover on the second use.',
        ],
      },
      {
        heading: 'Signing it, and sending it',
        paragraphs: [
          'Signing your own document needs no account and no email round-trip. Draw a signature with a mouse or a finger, type one and pick a rendered style, or upload an image of your existing signature, then place it where it goes. The date is often expected next to it, and a text box handles that.',
          'Before you send it back, consider flattening. Filled form values and placed signatures live as separate objects in the file, which means a recipient can in principle click into the fields and change them, or drag the signature. Flattening bakes everything into the page content, after which the document is a fixed picture of what you agreed to. It is one-way — there is no unflattening — so keep the unflattened copy if you might need to change an answer.',
          'For a document that other people have to sign, this is the wrong flow. Self-signing is you marking your own copy. A document that needs signatures from several people wants a signature request, which sends each person their own link, records who did what and when, and seals the finished document so that any later change to it is detectable. Sending requests to other people needs a free account, because an electronic signature record has to be attributable to somebody.',
        ],
      },
    ],
    relatedTools: ['fill-form', 'sign', 'annotate', 'edit'],
  },

  {
    slug: 'are-electronic-signatures-legally-binding',
    title: 'Are electronic signatures legally binding? | ZenPDF',
    metaDescription:
      'How ESIGN, UETA and eIDAS treat electronic signatures, what the three eIDAS tiers mean, and exactly what a simple electronic signature with a platform seal does and does not prove.',
    h1: 'Are electronic signatures legally binding?',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'In most of the world, and for most documents, yes. The law generally refuses to treat a signature as invalid merely because it is electronic. That is the easy half of the answer, and it is the half most articles stop at.',
          'The harder and more useful half is that "legally binding" is not one property. A signature that is admissible is not the same as a signature that is easy to prove, and neither is the same as a signature a particular regulator will accept for a particular document. This guide sets out the frameworks, what the tiers mean, and precisely what ZenPDF\'s signature is — so you can tell whether it is the right instrument for what you are signing.',
        ],
        note: {
          text: 'This page is general information about how electronic signature law is structured. It is not legal advice, it is not specific to your situation, and it is not a substitute for asking a lawyer about a document that matters. The exact text every signer agrees to is published in full:',
          link: { href: '/legal/esign-disclosure', label: 'the e-sign disclosure' },
        },
      },
      {
        heading: 'The frameworks',
        paragraphs: [
          'In the United States, two statutes do the work. The federal ESIGN Act (2000) and UETA, adopted in nearly every state, both establish that a record or signature may not be denied legal effect solely because it is in electronic form. Their requirements are about intent and process rather than technology: the signer must intend to sign, must consent to doing business electronically, the signature must be attributable to them, and the record must be retainable and reproducible by everyone entitled to it. Nothing in either statute prescribes a cryptographic method.',
          'In the European Union, eIDAS (Regulation 910/2014) takes a different shape. It defines three tiers, and it guarantees that a signature in the lowest tier cannot be denied legal effect or admissibility just for being electronic — while reserving one specific legal equivalence for the highest.',
          'Israel\'s Electronic Signature Law, 5761-2001, is structurally similar: it recognises electronic signatures generally, and defines a certified electronic signature with additional requirements and additional effect. As in the EU, particular statutes can require the higher form for particular acts.',
          'The pattern across all three is the same. General commercial agreements — contracts, NDAs, engagement letters, consent forms, purchase orders, employment paperwork — are the ordinary case, and an ordinary electronic signature carries them. Specific categories are carved out or escalated by other law, and those carve-outs are where care is needed.',
        ],
      },
      {
        heading: 'The three eIDAS tiers, briefly',
        paragraphs: [
          'A simple electronic signature (SES) is any data in electronic form attached to or logically associated with other data and used by the signer to sign. A typed name, a drawn mark, a click-to-accept. It is admissible and it can be perfectly sufficient; what it does not come with is a built-in proof of who produced it.',
          'An advanced electronic signature (AdES) adds requirements about the signature itself: it must be uniquely linked to the signer, capable of identifying them, created using means under their sole control, and linked to the data such that any subsequent change is detectable.',
          'A qualified electronic signature (QES) is an AdES created by a qualified signature creation device and based on a qualified certificate issued by a trust service provider on an EU trusted list, after identity verification. QES is the tier eIDAS grants the explicit legal equivalence of a handwritten signature, and it is what a Member State can require for particular acts.',
        ],
      },
      {
        heading: 'What ZenPDF\'s signature actually is',
        paragraphs: [
          'ZenPDF provides a simple electronic signature with a platform seal. It is not a qualified electronic signature, and we make no such claim — that sentence appears in the terms, in the disclosure every signer reads before signing, and in the footer of every signing page, because it is the single most important thing to be honest about.',
          'What that means in practice. The signature is your mark, applied by you, with your intent, after you were shown a consent disclosure and agreed to it. The identity assurance is possession of a unique link sent to a specific email address — good evidence, and not the government-verified identity a QES rests on.',
          'Around that mark sits a record. When each person opened the document, when they consented and to exactly which version of the disclosure text, what they filled in, when they completed it, their IP address and their browser\'s user-agent string. Every entry is cryptographically chained to the one before it, so an entry cannot be altered or removed without the chain failing to verify. That record is printed on a certificate of completion attached to the finished document.',
          'The disclosure text itself is versioned in our source repository, and the SHA-256 hash of the exact bytes a signer agreed to is written into their consent event. That is what makes the record meaningful a year later: without it, "the signer consented" means "consented to whatever the site said at the time", which nobody can reconstruct.',
        ],
      },
      {
        heading: 'What the seal proves, and what it does not',
        paragraphs: [
          'When the last person finishes, the completed document is sealed with a PAdES signature. The claim it makes is narrow and worth stating exactly: this file is byte-for-byte the one ZenPDF produced when the envelope completed. Change one byte of the PDF afterwards — a page, a value, a pixel — and the seal fails to validate in any conforming reader.',
          'Where a timestamp authority is configured, the seal is taken to PAdES B-T, which adds an RFC 3161 timestamp from an independent authority. That is what makes "this existed before this moment" a claim that does not depend on our own clock.',
          'The seal is the platform\'s, not the signer\'s. It does not assert who signed; the audit trail and the certificate do that. The seal is what makes tampering with either of them detectable. This is the correct division for a hosted signing service, and it is not the same thing as each signer holding their own certificate — which is what an AdES or QES arrangement involves.',
          'Anyone can check a sealed document without an account and without us: the verification page takes a file and reports whether the seal is intact and whether the envelope details match.',
        ],
      },
      {
        heading: 'When to use something else',
        paragraphs: [
          'Some documents are excluded from ESIGN and UETA outright or need a different form: wills and testamentary trusts, some family-law instruments, certain court filings, and various notices that specific statutes require on paper. Real property transfers, notarisation, and anything a regulator has specifically addressed all deserve a check before assuming.',
          'In the EU, if a statute requires a qualified electronic signature for the act you are performing, only a QES will do, and no amount of audit trail substitutes for it. The honest thing for a simple electronic signature service to say is that this is not what it provides.',
          'For the ordinary commercial case, the practical determinants of whether a signature holds up are unglamorous and mostly procedural: that the signer intended to sign, that they consented to electronic records, that you can show it was them, that the document has not changed since, and that everyone can still get a copy. Those are the things the record described above is built to establish.',
        ],
      },
    ],
    relatedTools: ['sign', 'fill-form'],
  },

  {
    slug: 'what-is-ocr-make-a-scanned-pdf-searchable',
    title: 'What is OCR? Making a scanned PDF searchable | ZenPDF',
    metaDescription:
      'What OCR adds to a scanned PDF, how to tell whether your file needs it, which languages are available including Hebrew, and where optical recognition reliably fails.',
    h1: 'What OCR is, and how to make a scan searchable',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'A scanned PDF is a photograph of a document. It looks like text to you and it is pixels to the computer — which is why searching it finds nothing, selecting it selects nothing, and copying from it copies nothing. Optical character recognition is the process of looking at those pixels, working out which letters they are, and writing the answer back into the file.',
          'The result is the same page you had, with an invisible text layer sitting exactly over the picture of the words. The document still looks like the scan it is. It has simply become searchable, selectable, and — the part people underestimate — accessible to a screen reader.',
        ],
      },
      {
        heading: 'Telling whether you need it',
        paragraphs: [
          'Open the file and try to select a line of text with the cursor. If a selection highlight follows the words, there is a text layer and you do not need OCR. If the cursor draws a rectangle over the page like a picture, or selects nothing at all, you have a scan.',
          'Searching is the other test: press find and look for a word you can plainly see on the page. No result means no text layer.',
          'One case confuses people. A document can be a scan on some pages and born-digital on others — a contract printed, signed, scanned, and then appended to a digital cover letter. Selection works on some pages and not others in the same file. That is normal, and it is handled: pages that already have real text are skipped by default, so their perfect existing text layer is not replaced by a guess at a picture of it. If you genuinely want everything re-read, there is an option to force it, and it is off by default for exactly that reason.',
        ],
      },
      {
        heading: 'Languages',
        paragraphs: [
          'Recognition is language-specific, because it uses knowledge of the language to resolve ambiguous shapes. English, Hebrew, German, French and Spanish are available. Hebrew is there deliberately rather than incidentally, and right-to-left text works properly, including selection and search over it.',
          'Choosing the right language matters more than people expect. Running English recognition over a German document produces plausible-looking nonsense around every umlaut and every ß, because the engine is choosing between letters using a model of what words look like — and it has the wrong model.',
          'A document containing two languages can be given both. Recognition slows down, because more candidate interpretations are considered per word, and accuracy on genuinely mixed pages improves. On a document that is really one language with a few borrowed words, picking the one main language is usually the better result.',
        ],
      },
      {
        heading: 'What OCR gets wrong',
        paragraphs: [
          'Accuracy on a clean, straight, 300 dpi scan of ordinary printed text is very high — high enough that the errors are rare enough to be surprising. It degrades in ways worth predicting.',
          'Handwriting is not recognised. This engine reads print; cursive is out of scope, and a handwritten annotation in the margin of an otherwise printed page will come back as noise or as nothing.',
          'Low-resolution scans hurt most. Below about 200 dpi, letterforms lose the detail that distinguishes similar shapes, and the classic confusions appear: rn read as m, 0 and O, 1 and l and I, 5 and S. If you control the scanning, 300 dpi is the number to aim for; going to 600 mostly costs you file size.',
          'Skew, shadows and creases all reduce accuracy, because the engine is matching shapes and a rotated or curved line of text is a different shape. There are options to deskew a crooked page and to clean up scanning artefacts before recognition, which help on exactly these documents.',
          'Complex layout is the other weak point. Multi-column pages, tables and text wrapped around figures are read in an order the engine infers, and it can infer wrongly — the words are all correct while the reading order is not. For searching this is harmless. For copying a table out, it is not.',
          'The important consequence: OCR output is a good guess, not a transcript. If the text will be used for anything consequential — a contract clause, a legal citation, a figure in a report — read it against the image rather than trusting it. The picture underneath is unchanged and remains the authoritative copy, which is exactly why the text layer is added invisibly over it rather than replacing it.',
        ],
      },
      {
        heading: 'Limits, and what comes after',
        paragraphs: [
          'OCR is the most computationally expensive thing on the site — it renders every page and runs a recognition pass over it — so it is metered. Without an account you can process 50 pages a day; a free account allows 2,000 pages a month. A long scanned book is an account-sized job.',
          'Encrypted documents have to be unlocked first, and a document already tagged as accessible text is refused with an explanation rather than being processed into something worse, because a tagged document already has real structure that recognition would fight.',
          'Once the text layer exists, several things become possible that were not. The document is searchable in any reader. Its text can be extracted or converted to Word with a real chance of a sensible result. Pattern-based redaction — finding every email address or ID number by matching text — starts working, which on a raw scan it cannot, because there is no text to match. And a screen reader can read the document aloud, which before OCR it could not do at all.',
        ],
      },
    ],
    relatedTools: ['ocr', 'pdf-to-word', 'redact', 'compare'],
  },

  {
    slug: 'pdf-to-word-conversion-explained',
    title: 'PDF to Word: what converts cleanly and what cannot | ZenPDF',
    metaDescription:
      'Why PDF-to-Word conversion is genuinely hard, which documents come out well, which come out badly, and how to get the best result from the ones in between.',
    h1: 'PDF to Word conversion, explained',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'Converting a PDF to Word is not the reverse of printing to PDF. It is closer to reading a finished page and inferring the document that must have produced it — and the honest description of the result is that it is a reconstruction, not a recovery.',
          'Understanding why makes the difference between being disappointed by conversion and using it well.',
        ],
      },
      {
        heading: 'Why this is hard',
        paragraphs: [
          'A Word document describes intent. This is a heading; this is a paragraph in this style; this table has these columns; this image floats here and text wraps around it. The layout is computed from that description when you open it, which is why changing the margins reflows everything sensibly.',
          'A PDF describes results. Place this glyph at this coordinate in this font at this size. Draw a line from here to here. There are no paragraphs in a PDF, only runs of characters that happen to sit on successive baselines. There are no tables, only text positioned in a grid and, if you are lucky, some lines drawn around it. The structure was discarded when the PDF was made — that is what made it render identically everywhere, and it is the thing conversion has to guess back.',
          'So a converter groups glyphs into words by spacing, words into lines by baseline, lines into paragraphs by leading and indentation, and lines and boxes into tables by geometry. Each of those steps is an inference, and each can be wrong in a way that looks like the converter being careless when it is in fact being reasonable about ambiguous evidence.',
        ],
      },
      {
        heading: 'What converts cleanly',
        paragraphs: [
          'Single-column, text-heavy, born-digital documents convert very well. Reports, letters, articles, contracts, theses: prose in one column with ordinary headings comes out close to right, usually needing only cosmetic attention.',
          'Simple tables with visible ruling lines usually survive as real Word tables. The lines give the converter unambiguous evidence about where the cells are, which is exactly what it needs.',
          'Standard fonts help. When a document uses widely available typefaces, the result can use the real thing. When it uses something unusual, Word substitutes, and substitution changes text metrics — which is why a converted document sometimes runs to one more page than the original.',
        ],
      },
      {
        heading: 'What does not',
        paragraphs: [
          'Scanned pages convert to a Word file containing a picture of a page. There is nothing else in the file to convert. This is the single most common disappointment, and the fix is to run OCR first: with a text layer, conversion has something to work with. Without one, no converter can do better, whatever it claims.',
          'Heavy magazine-style layout — multiple columns, pull quotes, text flowing around irregular images, floating sidebars — comes out as an approximation whose reading order may be wrong. The words are usually all there; the arrangement often is not.',
          'Borderless tables are frequently read as columns of text rather than tables, because the only evidence for a table was whitespace, and whitespace is also what separates paragraphs.',
          'Form fields, annotations and comments do not carry across as live objects. A PDF form becomes a Word document that looks like the form and does not behave like one.',
          'And equations, which in a PDF are usually a set of positioned glyphs and rules with no mathematical structure at all, do not come back as equations.',
        ],
      },
      {
        heading: 'Getting a better result',
        paragraphs: [
          'Convert the original rather than a copy that has been through other hands. Every round trip discards something, and a PDF that was itself produced from a scan of a printout has already lost the structure you are trying to recover.',
          'Run OCR first on anything scanned. It is the difference between a picture and a document.',
          'Ask whether you need Word at all. A great deal of PDF-to-Word conversion happens because someone wants to change three words, and editing the text directly in the PDF is both quicker and leaves every other pixel of the document exactly as it was. Editing in place is block-scoped — there is no reflow across paragraphs, and a replacement font approximates the original when the embedded one is a subset, which it usually is — but for a correction, a date, or a name, that is a smaller compromise than reconstructing the whole document.',
          'And if what you actually want is the words rather than the layout, extract plain text or Markdown instead. Asking for less structure gets you a result with fewer things that can be wrong.',
          'Finally: expect to fix things, and budget for it. A converted document is a starting point that saves you retyping, not a finished file. Conversions run on our servers with no third-party API involved, and without an account the input and output are deleted automatically within 24 hours — exports specifically are kept for 24 hours and then removed — so download the result rather than planning to come back for it tomorrow.',
        ],
      },
    ],
    relatedTools: ['pdf-to-word', 'ocr', 'edit', 'word-to-pdf'],
  },

  {
    slug: 'how-to-redact-a-pdf-properly',
    title: 'How to redact a PDF properly (a black box is not redaction) | ZenPDF',
    metaDescription:
      'Why drawing a black rectangle over text leaves it fully readable, what real redaction removes, when to use areas rather than patterns, and how to verify the result.',
    h1: 'How to redact a PDF properly',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'Redaction failures are a genre. A government department publishes a report with names blacked out and someone copies the text straight out of it. A law firm files a document with a black rectangle over a figure and the figure is in the file underneath. These are not exotic attacks. They are what happens when a rectangle gets mistaken for a removal.',
          'The distinction is simple and absolute: covering is drawing, removing is redaction. Only one of them makes the content go away.',
        ],
      },
      {
        heading: 'Why a black box fails',
        paragraphs: [
          'A PDF page is a list of drawing instructions carried out in order. Put this text here. Draw this filled rectangle there. When you add a black rectangle over a name, you have appended one more instruction to the list. The instruction that draws the name is still in the file, still complete, and still executed — it simply happens before something opaque is painted on top of it.',
          'Everything that reads the file rather than looking at it can still see the text. Select the region and copy it, and the name comes out. Extract the text with any tool and it is there. Search the document and it matches. Open the file in something that lets you delete objects, remove the rectangle, and the name is on screen again.',
          'The same is true of a white box, which is often worse because it is invisible on white paper and nobody realises anything was supposedly hidden at all. Whiteout has a legitimate use — tidying an artefact on a page — and it is not a security tool. That is why in the editor it is described as hiding rather than removing.',
          'Highlighter over text, changing the text colour to match the background, and putting an image over the region all fail the same way and for the same reason.',
        ],
      },
      {
        heading: 'What real redaction does',
        paragraphs: [
          'Proper redaction operates on the content itself. The glyphs are deleted from the page\'s content stream, so the characters are gone from the file rather than concealed within it. Any image the redaction rectangle touches has the pixels inside that rectangle destroyed, not covered — which is what makes redacting a face in a photograph or a signature on a scan actually work.',
          'After that, a black rectangle is drawn where the content was. The visible mark is the last step and the least important one; it is there so a reader can see that something was removed. In a properly redacted document you can select over the mark and get nothing, because there is nothing to get.',
        ],
      },
      {
        heading: 'Areas and patterns',
        paragraphs: [
          'There are two ways to say what should go, and choosing correctly matters.',
          'Areas are rectangles you draw on the page. They remove whatever is inside them, regardless of what it is: text, part of an image, a signature, a barcode. This is the only thing that works on a scan, on text that was converted to outlines, and on anything that is not text in the first place.',
          'Patterns match against the page\'s own words. A preset (social security numbers, email addresses, phone numbers, card numbers, IBANs), a plain search, or your own regular expression. This is how you remove every occurrence of something from a 200-page document without reading all 200 pages.',
          'The trap is that patterns find text and nothing else. Text drawn as curves, and text inside an image, are invisible to them — so on a scanned document a pattern search finds nothing at all and reports, accurately, that it removed nothing. On a scan, either run OCR first so there is text to match, or use areas.',
          'The presets are deliberately conservative. A pattern that also matches ordinary prose would redact a document into uselessness, and you cannot see what it took until afterwards. The phone pattern requires punctuation rather than accepting any eight digits, because the permissive version ate invoice numbers and part numbers; card numbers are checked against the Luhn algorithm afterwards so an order number that happens to look like a card is left alone.',
          'Whichever you use, run a dry pass first. Seeing the list of matches before anything is removed is how you catch the pattern that was going to take a column heading with it.',
        ],
      },
      {
        heading: 'Verifying, and getting the order right',
        paragraphs: [
          'After redaction the document is re-read and the same patterns are run over the result, and the report tells you how many matches remain. Residue is not expected. But "not expected" is not the same as "checked", and this is the one operation where the difference matters to somebody.',
          'Do your own check as well, and check the things the tool cannot: search the finished document for the name you removed, select over each black mark and try to copy, and look at the document properties. That last one catches a real and commonly missed leak — the title, author and subject fields, and any embedded XMP metadata, are not on any page and are not touched by redacting pages. A file whose every page is clean and whose metadata still names the person is not redacted. Sanitising the document removes those, and reports what it found, so you know whether it had a script or an embedded file in it rather than merely that it does not now.',
          'Two more sources of leaks worth knowing about. Attachments embedded in the PDF are separate files carried inside it and are not affected by anything you do to a page. And bookmarks and internal link targets can carry names in their labels.',
          'Finally, order of operations. Redact first, then everything else. If you flatten a document with annotations on it and then redact, you are redacting a page that already has the annotation baked into it — which is fine — but if you redact and then someone reverts to an earlier version, they have the unredacted original. Every operation here appends a new version rather than overwriting, which is good for undo and worth understanding for redaction: the earlier version still exists in your library until you delete the document. For a document being published externally, download the redacted result and distribute that file, rather than sharing something that has a history attached to it.',
        ],
      },
    ],
    relatedTools: ['redact', 'ocr', 'protect', 'annotate'],
  },

  {
    slug: 'password-protect-pdf-what-encryption-actually-does',
    title: 'Password-protecting a PDF: what encryption actually does | ZenPDF',
    metaDescription:
      'The difference between the two PDF passwords, why AES-256 matters, why permission flags are advisory rather than security, and what happens to accessibility.',
    h1: 'Password-protecting a PDF: what encryption actually does',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          '"Protect this PDF" covers two quite different mechanisms that happen to be configured in the same place. One is real cryptography. The other is a polite request. Knowing which is which is the difference between a document that is safe to email and a document you only believe is safe to email.',
        ],
      },
      {
        heading: 'Two passwords with two different jobs',
        paragraphs: [
          'The user password — sometimes called the open password — is required to open the document at all. Without it the file is ciphertext and no reader can display anything. This is the one that provides actual protection.',
          'The owner password — the permissions password — does not affect opening. A document with only an owner password opens for anyone. What the owner password protects is the ability to *change the restrictions*, and it is required whenever you set them, because a permission set that nobody can lift is a document its author cannot recover.',
          'You can set either or both. A document with only a user password is encrypted and, once opened, unrestricted. A document with only an owner password opens freely and asks readers to respect its restrictions. A document with both is encrypted and restricted.',
          'One consequence worth stating: if you set a user password and lose it, the document is gone. That is not a policy we could relax; it is what encryption means. There is no recovery path, here or anywhere.',
        ],
      },
      {
        heading: 'AES-256, and why the version matters',
        paragraphs: [
          'PDF encryption has a long history and most of it is broken. 40-bit RC4 from the 1990s is trivially crackable now. 128-bit RC4 is weak. The older AES-128 revision 4 scheme has a flaw in how it derives keys that makes password recovery far faster than it should be.',
          'Documents here are encrypted with AES-256 at revision 6, which is the modern scheme and the only one in the PDF specification that is not trivially strippable. With a strong password, a document encrypted this way is genuinely protected — the limiting factor is the password, not the cipher.',
          'Which puts the weight where it belongs. A 256-bit cipher guarding the password "Summer2026" is guarding nothing; anyone attacking the file guesses passwords rather than attacking the mathematics. Use a long passphrase, and send it to the recipient by some route other than the email carrying the document — a password in the same message as the file it protects is decoration.',
        ],
      },
      {
        heading: 'Permission flags are advisory, and should be treated as such',
        paragraphs: [
          'The permission set — may print, may copy text, may modify, may annotate, may fill forms — is a set of flags stored in the document. Conforming readers honour them. Nothing enforces them.',
          'The flags are stored in the file itself, and a reader that chooses not to look at them simply does not. Plenty of software ignores them entirely. Once a document is open on someone\'s screen, "cannot copy" means their reader will not offer copy; it does not mean the text is unavailable to a program reading the file, and it certainly does not stop a screenshot.',
          'This makes permission flags a way of expressing intent — "this is not meant to be edited" — and a reminder to a cooperative user. They are not a control. If content genuinely must not be printed or extracted, permission flags will not achieve that, and no PDF feature will; the answer is not to send the content.',
          'Printing and modification are graded rather than boolean, because the PDF specification has more than one flag for each and collapsing them loses real distinctions. Printing can be forbidden, allowed only at low resolution, or allowed fully. Modification can be forbidden, or limited to filling in form fields, or to adding annotations, or unrestricted. Low-resolution printing is the one people reach for to allow a reading copy while discouraging a clean reproduction.',
        ],
      },
      {
        heading: 'Accessibility is never restricted',
        paragraphs: [
          'One permission is hard-wired on and cannot be turned off: text extraction for accessibility. A screen reader is not a threat model, and a PDF a blind person cannot read is a document that excludes them for no security gain — particularly since the "copy" restriction it would otherwise ride along with is advisory anyway.',
          'So the flag that would block assistive technology is always set to allow. This is a deliberate decision, and it costs nothing real: the protection that matters comes from the user password, and that is unaffected.',
        ],
      },
      {
        heading: 'Removing protection, and choosing between them',
        paragraphs: [
          'Removing a password requires the password. Supply it and encryption is stripped entirely, leaving an ordinary unprotected PDF — useful when you have the credentials but the protection is now in your way, for instance because every tool you want to run on the document has to ask for it first. This is not password cracking and cannot be; without the password there is nothing to be done.',
          'Practical guidance. If the concern is a document being read by the wrong person, set a user password and send it separately. If the concern is a document being edited and passed off as original, a password is the wrong instrument entirely — sign it instead, because a signature makes any subsequent change detectable rather than trying to prevent it. And if the concern is specific content within a document that will be shared, neither encryption nor permissions is the answer; removing that content is.',
        ],
      },
    ],
    relatedTools: ['protect', 'unlock', 'redact', 'sign'],
  },

  {
    slug: 'organize-scanned-pages-split-reorder-rotate',
    title: 'Organising scanned pages: split, reorder, rotate | ZenPDF',
    metaDescription:
      'What to do with the one long file a scanner produces: rotating sideways pages, fixing the order, splitting into real documents, and handling a two-pass duplex scan.',
    h1: 'Organising scanned pages: split, reorder, rotate',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'A document feeder produces one file. What went into it was often several documents, some of them upside down, a few sideways, and at least one in the wrong place. Sorting that out is a handful of operations, and doing them in a sensible order turns a fiddly afternoon into a few minutes.',
        ],
      },
      {
        heading: 'Rotation is a property, not a redraw',
        paragraphs: [
          'A rotated page is not re-rendered. Every PDF page carries a rotation property, and rotating a page sets it. Nothing about the page content is touched, nothing is resampled, and there is no quality cost whatsoever — which is worth knowing because it means you can rotate freely without wondering what it is costing you.',
          'It also means rotation is exact. There is no half-degree of skew introduced. If a page is sideways it becomes upright, precisely.',
          'What rotation cannot fix is a page that is skewed rather than rotated — the slight tilt from a sheet that went through the feeder crooked. That is a few degrees, not ninety, and it is a property of the image rather than of the page. The deskew option in OCR is what addresses that, because it works on the picture.',
          'Rotate before you do anything that stamps content onto pages. Page numbers, headers and Bates numbers are placed to read upright to the viewer, taking the page\'s rotation into account — so if you stamp first and rotate afterwards, the stamp rotates with the page and ends up sideways along with everything else.',
        ],
      },
      {
        heading: 'Reordering, and doing it visually',
        paragraphs: [
          'Reordering is a permutation: the same pages, in a different sequence. Nothing is added or lost, and the operation refuses anything that is not a genuine permutation, which is the guard against a drag that would have silently dropped a page.',
          'Do this in the thumbnail grid rather than by typing page numbers. Scanned pages are much easier to identify by their appearance than by their index, and the moment you move one page every subsequent number changes — which is the mechanism behind most reordering mistakes. Dragging in a grid does not have that problem because you are pointing at the page you mean.',
          'The duplex case deserves its own note, because it is common and the obvious approach fails. Scanning a two-sided stack in two passes gives you one file of odd pages and one file of even pages, and merging them concatenates rather than interleaves: all the fronts, then all the backs. What you want is an alternate mix, which takes one page from each in turn. If the second pass was run without turning the stack over, the even pages will be in reverse order — worth checking before mixing rather than after.',
        ],
      },
      {
        heading: 'Splitting and extracting',
        paragraphs: [
          'These are two different operations and people reach for the wrong one regularly.',
          'Splitting breaks a document into pieces — every page becoming its own file. It is the right answer when a feeder has produced one file from several separate documents and you want each of them back as an individual file. The pieces come out as separate documents rather than as a zip archive, so you can take only the ones you want instead of downloading everything and discarding most of it.',
          'Extracting pulls out a chosen set of pages — "3, 7, 12-18" — and leaves the original alone. That is what you want when you need one section of a report to send to someone, and the rest is irrelevant.',
          'Both copy pages rather than re-rendering them, so text stays selectable and images keep their resolution. And both are limited in the same way: splitting divides a document into pages, not pages in half. A two-page spread scanned as one sheet is one page, and it stays one page. Separating that needs cropping — twice, into two documents — rather than splitting.',
        ],
      },
      {
        heading: 'A sensible order of operations',
        paragraphs: [
          'Rotate first, so that everything after this point is looking at pages the right way up. Then delete what should not be there: blank separator sheets, the cover of the scanner lid, the page that went through twice. Deleting early means every later step handles fewer pages.',
          'Then reorder, then split or extract into the documents you actually wanted. Doing the arranging before the splitting means one pass over one file rather than the same fiddling repeated across six.',
          'Only then run OCR, if you want the results searchable. OCR is the expensive step, and running it on a file you are about to cut into six pieces means paying for pages you are going to throw away. Running it last means paying only for what you kept. Without an account that is 50 pages a day, so the saving is not theoretical.',
          'Finally, compress if the files need to be smaller, and download. Guest files are deleted automatically within 24 hours, and for a session that started with one enormous scan that limit arrives sooner than you expect.',
        ],
      },
    ],
    relatedTools: ['organize', 'split', 'rotate', 'extract-pages'],
  },

  {
    slug: 'email-a-pdf-thats-too-big',
    title: 'How to email a PDF that is too big | ZenPDF',
    metaDescription:
      'Why a 25 MB attachment limit is really about 18 MB, which of compression and splitting to reach for, and the approaches that do not help despite seeming as though they should.',
    h1: 'How to email a PDF that is too big',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'The attachment bounces, or worse, it silently never arrives. There are three real approaches — make the file smaller, make it into several files, or do not attach it at all — and which is right depends on why the file is big and who has to read it.',
        ],
      },
      {
        heading: 'The limit is lower than the number you were given',
        paragraphs: [
          'Common limits sit around 25 MB, but the number that matters is smaller than that. Mail attachments are encoded in a way that inflates them by roughly a third, so a "25 MB limit" means something closer to 18 MB of actual file. Aim under that rather than at it.',
          'The other trap is that the limit that stops you is the smallest one along the path. Your provider might allow 25 MB and the recipient\'s might allow 10. A corporate gateway may impose its own. You will usually find out from a bounce, and sometimes not at all — some systems discard silently, which is why a message that vanished is worth a follow-up rather than an assumption.',
          'A practical target: get under 10 MB if you can, and you will stop thinking about this.',
        ],
      },
      {
        heading: 'Work out where the size is first',
        paragraphs: [
          'Two files of the same size can need opposite treatments, so spend a moment on what you have.',
          'If the document is scanned — a photograph of each page — the size is in the images and compression will help enormously. This is the overwhelmingly common case for files that are unexpectedly large.',
          'If it is born-digital and text-heavy but still huge, the size is usually in embedded fonts, in accumulated revision history, or in a small number of very high-resolution images among the text. Structural compression helps here without touching anything visible.',
          'If it is a long document that is legitimately long — a 500-page manual that is 40 MB because it is 500 pages — compression will not save you, because nothing is wasteful. That file needs splitting or a link.',
        ],
      },
      {
        heading: 'Compression first, and how hard to push',
        paragraphs: [
          'Start with the balanced preset, which re-encodes images at around 150 dpi and subsets the fonts. On a colour scan this typically produces a large reduction, and on screen at normal zoom the result usually looks the same.',
          'If that is not enough and the content is text on paper — a signed contract, a scanned form — the strong preset takes images to about 110 dpi and converts them to greyscale. It is a visible trade, and for a document whose job is to be read rather than admired it is usually an acceptable one. Look at the result before sending it; you are the one who knows whether the small print still needs to be legible.',
          'If a file comes back unchanged with a note that it was already optimised, that is the honest answer rather than a failure: the gain would have been under three per cent, and re-encoding every image for that would have cost real quality for nothing. Move on to splitting.',
        ],
      },
      {
        heading: 'Splitting, and what to send instead',
        paragraphs: [
          'For a long document, several files are often better than one crushed one — three readable 8 MB parts beat one illegible 24 MB file, and the recipient can start reading part one immediately.',
          'Split along boundaries the reader will recognise, not at arbitrary page counts. "Chapters 1-3", "Chapters 4-6" is a document in parts; "pages 1-40", "pages 41-80" is a puzzle. Extracting ranges is the operation for that. Name the files so the order is obvious, and say in the message how many parts there are, so a missing one is noticed.',
          'Before splitting, ask whether the recipient needs all of it. A great deal of oversized-attachment trouble is someone sending a 200-page report because it contains the six pages that answer the question. Extracting those six pages is faster for everybody and usually more useful.',
          'And the honest last resort: do not attach it. Upload the file somewhere and send a link. Any file-sharing service does this. It sidesteps every limit, it lets you replace the file if you find a mistake, and it does not sit in anyone\'s mailbox forever.',
        ],
      },
      {
        heading: 'Things that do not help',
        paragraphs: [
          'Zipping a PDF. PDFs are already compressed internally, so a zip of one is essentially the same size, and you have added a step for the recipient and given their mail filter something to be suspicious about. Zipping is for grouping several files, not for shrinking one.',
          'Splitting into a multi-part archive. The recipient needs every part and the right software, and if one message is filtered they get nothing. This produces support requests, not delivered documents.',
          'Printing to PDF again in the hope that it comes out smaller. Sometimes it does, by re-encoding images at whatever the print pipeline chose — with no control over the trade and often a worse result than a compression preset you selected deliberately.',
          'Screenshotting each page. It makes the file larger, not smaller, and it destroys the text layer, the searchability and the accessibility along the way.',
        ],
      },
    ],
    relatedTools: ['compress', 'split', 'extract-pages', 'merge'],
  },

  {
    slug: 'pdf-page-numbers-and-bates-stamping',
    title: 'Page numbers and Bates stamping: which one you need | ZenPDF',
    metaDescription:
      'Page numbers count within a document; Bates numbers identify pages across a production. What each is for, how ranges and starting values work, and why rotated pages matter.',
    h1: 'Page numbers and Bates stamping',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'These two look almost identical on the page — a small number in a corner — and they answer completely different questions. Page numbers tell a reader where they are inside a document. Bates numbers give every page a unique identifier across a whole production of documents, so that a page can be referred to unambiguously by anyone holding a different copy.',
          'Reaching for the wrong one is easy and the consequences arrive late, usually when someone cites a page and nobody can find it.',
        ],
      },
      {
        heading: 'Page numbers',
        paragraphs: [
          'A page number is positional and restarts with each document. Page 12 of a report is the twelfth page of that report, and page 12 of a different report is a different page entirely. That is fine, because the number is only ever used together with the document it is in.',
          'Numbers can go in any of the standard positions — the three across the bottom and the three across the top — and the format is a template rather than a bare number, so "Page 3 of 40" and "3" and a date alongside are all the same mechanism with different tokens filled in.',
          'The starting value is separate from the position of the page in the file, and it is what makes covers and front matter work. A report with a cover and two pages of contents usually wants the body to begin at 1, which means numbering a range that starts on the fourth page while telling it to start counting at 1. Getting this wrong is the most common page-numbering mistake, and the symptom is a document whose printed numbers are three higher than everybody expects.',
          'Two practical points. Check that the position you chose does not land on existing content — many documents already have something in the footer, and a number stamped over it is worse than no number. And if you are producing something that will be printed double-sided and bound, the outer corner alternates between left and right on facing pages, which is worth deciding deliberately rather than discovering at the printer.',
        ],
      },
      {
        heading: 'Bates numbering',
        paragraphs: [
          'Bates numbering comes from litigation discovery and from any process where documents from many sources are combined into one production. Every page gets a unique identifier, and it stays that page\'s identifier permanently.',
          'The format is a prefix, a zero-padded number, and optionally a suffix: ABC000001, ABC000002, and so on. The prefix identifies the producing party or the matter. The padding — usually six digits — exists so that identifiers sort correctly as text, which they do not if the number is unpadded. Both prefix and padding width are yours to set, and the padding can be anywhere from one to twelve digits.',
          'The property that makes Bates numbering worth the ceremony is that the numbers continue across documents. The first document might be stamped 1 to 340, the next starting at 341, the next at 981. This is why the operation reports the exact range it stamped when it finishes — so the next batch can start where the last one ended without anyone counting pages by hand or, worse, guessing. Overlapping ranges across a production is the failure this is designed to prevent, and it is not a recoverable one once the production has gone out.',
          'Bates stamping is applied atomically: either every page in the range gets its number or none does. A half-stamped document with a gap in the middle would be worse than an unstamped one, because it looks finished.',
        ],
      },
      {
        heading: 'Which one you need',
        paragraphs: [
          'If the number is for a reader finding their way inside one document, you want page numbers. Reports, manuals, theses, contracts being circulated for review.',
          'If the number is for identifying a specific page across a set of documents held by several people, you want Bates numbers. Discovery productions, regulatory filings, evidence bundles, any bundle where a reference has to be unambiguous.',
          'A document can carry both, and in litigation often does: page numbers so a reader can navigate the document, Bates numbers so a court can cite it. Put them in different positions — a page number bottom-centre and a Bates number bottom-right is the usual arrangement — and stamp them in separate passes.',
        ],
      },
      {
        heading: 'Rotated pages, and doing it last',
        paragraphs: [
          'Stamps are placed relative to what the reader sees, and turned so they read upright regardless of how the page is rotated. A bottom-right stamp on a page rotated ninety degrees appears at the bottom right as displayed, the right way up.',
          'This is worth knowing because it is easy to get wrong in the other direction. If you stamp a document and then rotate its pages, the stamp is part of the page content and rotates with it — so it ends up sideways along with everything else. Rotate first, stamp afterwards.',
          'The same logic applies to every other structural change. Merging, splitting, inserting and deleting pages all change which page is which, and a page number stamped before a merge is a claim that stops being true the moment the merge happens. Stamping is the last step before the document goes out, not a step in the middle of preparing it. For Bates numbering this is not merely tidy: renumbering a production after it has been distributed is not really possible, because the old numbers are the ones people have already cited.',
        ],
      },
    ],
    relatedTools: ['page-numbers', 'watermark', 'merge', 'organize'],
  },

  {
    slug: 'flatten-pdf-what-it-means',
    title: 'What flattening a PDF means, and when to do it | ZenPDF',
    metaDescription:
      'Annotations and form fields are separate objects layered over the page. What flattening does to them, when it is the right move, and why it cannot be undone.',
    h1: 'What flattening a PDF means',
    published: '2026-08-24',
    updated: '2026-08-24',
    sections: [
      {
        paragraphs: [
          'Flattening is one of those operations people run because a tool suggested it, without a clear picture of what it changes. It is worth understanding, because it is genuinely useful, genuinely destructive, and completely one-way.',
        ],
      },
      {
        heading: 'A PDF page has things that are not on it',
        paragraphs: [
          'The page content is the drawing instructions: place these glyphs here, draw this image there. That is the page.',
          'Annotations are separate objects that sit alongside the page and are drawn over it by the reader. Highlights, comments, ink drawings, stamps, arrows, text boxes. They are not part of the page content; they reference the page and say where on it they appear. This is why you can select a highlight and move it, why comments can be listed in a sidebar and replied to, and why a highlight can be deleted leaving the text underneath untouched.',
          'Form fields are separate objects too, with a further twist: a field has a value and an appearance generated from that value. Type a name into a text field and the field\'s value becomes the name, and the reader draws it. The page content underneath is unchanged.',
          'So a filled, annotated PDF is a page plus a set of objects hovering above it — and everything above the page is live, editable and, importantly, removable.',
        ],
      },
      {
        heading: 'What flattening does',
        paragraphs: [
          'Flattening takes those hovering objects, draws them permanently into the page content, and deletes the objects. What was a form field with a value becomes ink on the page that happens to look exactly like it did. What was a highlight becomes coloured marking in the page content.',
          'Visually, nothing changes. Structurally, everything does. After flattening there are no fields to fill, no annotations to select, no comments to reply to, and nothing to delete — because there is nothing there any more except a page that looks the way the composite looked.',
          'You can flatten annotations only, form fields only, or both — which matters more often than it sounds. Locking down a completed form while keeping reviewers\' comments live is a real workflow, and so is the reverse.',
        ],
      },
      {
        heading: 'When to flatten',
        paragraphs: [
          'Before sending a completed form back. This is the main case. A filled form still has live fields, so the recipient can click into them and change your answers — and, more mundanely, a reader that does not render field appearances the way yours did can display them differently or not at all. Flattening makes the document a fixed picture of what you submitted.',
          'Before printing anything that matters. Most readers print annotations, but not all, and not all by default. A flattened document prints the same everywhere because there is nothing left that a reader could decide to omit.',
          'When you want annotations to be part of the document rather than commentary on it. Review comments are commentary and should stay live so they can be answered and resolved. A redaction mark, a "DRAFT" stamp, or an approval mark is part of the record, and belongs in the page.',
          'To stop a signature being moved. A placed signature image is an annotation like any other, which means it can be dragged or deleted. Flattening fixes it in place.',
          'And to make a document render identically everywhere. Annotation rendering varies between readers more than page content does. If a document must look the same to everyone, flattening removes the variability.',
        ],
      },
      {
        heading: 'When not to, and what flattening is not',
        paragraphs: [
          'Do not flatten a document still under review — you would be deleting the conversation. Do not flatten a form template, which is the fields; flattening one leaves you a picture of an empty form. Do not flatten before you are sure the answers are right, because correcting a flattened field means editing page content rather than retyping a value. And do not flatten anything you may need the data out of: exporting field values as JSON or CSV works only while the fields exist.',
          'Two things flattening is emphatically not. It is not redaction. Flattening a black box over a name draws that box into the page content, and the text underneath is still in the page content too — flattening adds, it does not remove. Redaction deletes the underlying content, and it is a different operation for a different purpose.',
          'And it is not compression. Flattening can make a file slightly larger, because appearance streams get written into the page. If the goal is a smaller file, compress.',
          'Finally, the one-way part. There is no unflatten. Once annotations are part of the page there is nothing to distinguish them from anything else drawn there. In practice this is softened by versioning: every operation here appends a new version rather than overwriting, so the unflattened version is still in the document\'s history and you can go back to it. That is a safety net inside your own library, not a property of the file — the flattened PDF you downloaded and emailed is flattened permanently, for you and for everyone who receives it.',
        ],
      },
    ],
    relatedTools: ['annotate', 'fill-form', 'redact', 'compress'],
  },
];

/** Slugs, in table order — the routes and the sitemap are built from this. */
export const GUIDE_SLUGS = GUIDE_PAGES.map((g) => g.slug);

export function guideBySlug(slug: string): GuidePageDef | undefined {
  return GUIDE_PAGES.find((g) => g.slug === slug);
}
