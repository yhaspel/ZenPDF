/**
 * The public tool-page route table (01-architecture.md §21.6).
 *
 * `sitemap.xml` is **generated from this table**, not hand-maintained — a tool
 * page that exists but is not in the sitemap is a bug. Each page is itself the
 * working tool: dropzone above the fold, no login prompt anywhere in the path,
 * result downloadable in place.
 */
export type ToolKind =
  | 'merge'
  | 'split'
  | 'compress'
  | 'rotate'
  | 'delete-pages'
  | 'extract-pages'
  | 'organize'
  | 'annotate'
  | 'edit'
  | 'watermark'
  | 'page-numbers'
  | 'fill-form'
  | 'ocr'
  | 'pdf-to-word'
  | 'word-to-pdf'
  | 'jpg-to-pdf'
  | 'pdf-to-jpg'
  | 'html-to-pdf'
  | 'compare'
  | 'repair'
  | 'protect'
  | 'unlock'
  | 'redact'
  | 'sign';

export interface ToolFaq {
  q: string;
  a: string;
}

export interface ToolPageDef {
  slug: string;
  kind: ToolKind;
  /** Unique <title>. */
  title: string;
  metaDescription: string;
  h1: string;
  /** ~300 words of honest task copy, split into paragraphs. */
  intro: string[];
  faq: ToolFaq[];
  /** How many files the dropzone accepts before the tool can run. */
  minFiles: number;
  multiple: boolean;
  cta: string;
}

export const TOOL_PAGES: ToolPageDef[] = [
  {
    slug: 'merge-pdf',
    kind: 'merge',
    title: 'Merge PDF — combine PDF files online free | ZenPDF',
    metaDescription:
      'Combine two or more PDF files into one document, in your browser, with no account and no watermark. Files are deleted automatically within 24 hours.',
    h1: 'Merge PDF files',
    intro: [
      'Combine several PDFs into a single document. Add the files in the order you want them, and ZenPDF joins them into one PDF you can download straight away.',
      'Everything runs on our servers using open-source PDF tooling, and nothing is sent to a third party. You do not need an account: drop the files in, get the result, and close the tab if you like. Guest files are deleted automatically within 24 hours.',
      'Page order follows the order you add the files. If you need a different arrangement — moving individual pages around, rotating some of them, or removing a few — open the merged file in the workspace afterwards and organize it there.',
      'Creating a free account is optional. It keeps your documents in a library instead of expiring, raises the file-size and page limits, and lets you send documents for signature.',
      'There is no fixed limit on how many files you can combine in one go, though each file has to fit the guest limits: 25 MB and 300 pages. If you are working with a stack of scanned chapters, merge them in batches and then merge the batches.',
      'Bookmarks and internal links from the source files are not carried across — a merged PDF gets a fresh, flat structure. If you depend on an outline, rebuild it after merging rather than expecting it to survive.',
      'If a source file is encrypted you will be asked to unlock it first: we do not silently skip a file you asked us to include, because a merged document that is quietly missing a chapter is worse than an error message.',
    ],
    faq: [
      {
        q: 'Is merging PDFs free?',
        a: 'Yes. Merging is free and needs no account. There is no watermark on the result and no "sign up to download" step.',
      },
      {
        q: 'How many PDFs can I merge at once?',
        a: 'As many as you like, within the guest limits: 25 MB per file and 300 pages per document. A free account raises both.',
      },
      {
        q: 'What happens to my files?',
        a: 'They are stored only long enough for you to work with them. Without an account they are deleted automatically within 24 hours; with an account they stay in your library until you delete them.',
      },
      {
        q: 'Does merging change the quality of my PDF?',
        a: 'No. Pages are copied across as-is, so text stays selectable and images keep their original resolution.',
      },
    ],
    minFiles: 2,
    multiple: true,
    cta: 'Merge PDFs',
  },
  {
    slug: 'split-pdf',
    kind: 'split',
    title: 'Split PDF — separate pages from a PDF online free | ZenPDF',
    metaDescription:
      'Split a PDF into separate documents, one per page or by custom ranges. Free, no account, no watermark. Files auto-delete within 24 hours.',
    h1: 'Split a PDF',
    intro: [
      'Break one PDF into several smaller documents. ZenPDF splits every page into its own file, and you can download the pieces individually.',
      'The whole thing works without an account. Drop the file in, run the split, and take the results. Nothing is watermarked and nothing is held back behind a signup form.',
      'Splitting is useful when a scanner has produced one long file out of several separate documents, or when you only need to send a section of a report to someone rather than the whole thing.',
      'For finer control — pulling out a specific set of pages rather than splitting everything — use the extract tool instead, or open the document in the workspace and choose the pages you want.',
      'The pieces are produced as separate documents rather than a zip archive, so you can download only the ones you actually want instead of pulling down everything and discarding most of it.',
      'Splitting copies pages rather than re-rendering them, so text stays selectable, images keep their resolution, and file sizes stay proportional to the content that moved into each piece.',
      'One thing worth knowing: a page that was part of a larger layout — a two-page spread scanned as one sheet, for instance — will still be one page after splitting. Splitting divides a document into pages; it does not divide a page in half.',
      'Encrypted documents have to be unlocked before they can be split, and a damaged file is offered a repair pass on upload rather than being rejected outright. Both cases tell you what happened instead of failing silently.',
    ],
    faq: [
      {
        q: 'Can I split a PDF without installing anything?',
        a: 'Yes. It runs entirely in the browser against our servers — there is nothing to install and no account to create.',
      },
      {
        q: 'Can I split by page ranges?',
        a: 'The tool page splits every page into its own document. For custom ranges, open the file in the workspace and use the split dialog there.',
      },
      {
        q: 'Is there a page limit?',
        a: 'Guests can work with documents up to 300 pages and 25 MB. A free account raises that to 2000 pages and 100 MB.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Split PDF',
  },
  {
    slug: 'compress-pdf',
    kind: 'compress',
    title: 'Compress PDF — reduce PDF file size online free | ZenPDF',
    metaDescription:
      'Make a PDF smaller without wrecking it. Free PDF compression with no account and no watermark. Files auto-delete within 24 hours.',
    h1: 'Compress a PDF',
    intro: [
      'Reduce the size of a PDF so it fits an upload limit or an email attachment. ZenPDF re-encodes the images and strips redundant data, leaving the text layer intact so the document stays searchable.',
      'How much smaller a file gets depends on what is in it. Scanned documents, which are really just pages of images, usually shrink a lot. A PDF that is mostly text is already small and will not change much — we would rather tell you that than promise a number we cannot hit.',
      'No account is needed, and the compressed file is not watermarked. Download it and carry on.',
      'If the result is still too large, try splitting the document and sending the parts separately, or remove pages you do not need.',
      'Compression is lossy for images and lossless for everything else. That is the honest trade: the text, vectors and structure of the document are preserved exactly, while photographs and scanned page images are re-encoded at a lower resolution.',
      'If a file will not shrink, that usually means it was already efficient — a text-heavy report generated by a word processor has very little redundancy left to remove. In that case the size is the content, and compressing again will not help.',
      'The compressed file is a new version of the document rather than a replacement, so if the result is not acceptable you can go back to the original in the workspace and try a different approach.',
      'For scanned paperwork the biggest single win is usually not compression at all but making sure the scan was not captured at a needlessly high DPI in the first place. Compression can recover some of that, but it cannot recover detail that was never useful.',
    ],
    faq: [
      {
        q: 'Will compressing make my PDF blurry?',
        a: 'Text stays sharp — it is not an image. Photographs and scans are re-encoded at a lower resolution, which is where the size saving comes from, so there is a visible trade-off on image-heavy files.',
      },
      {
        q: 'How much smaller will my file get?',
        a: 'Scanned documents commonly drop by half or more. Text-only PDFs are already compact and may barely change.',
      },
      {
        q: 'Is compression free?',
        a: 'Yes, with no account and no watermark.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Compress PDF',
  },
  {
    slug: 'rotate-pdf',
    kind: 'rotate',
    title: 'Rotate PDF — turn PDF pages online free | ZenPDF',
    metaDescription:
      'Rotate every page of a PDF by 90 degrees and save it permanently. Free, no account, no watermark.',
    h1: 'Rotate PDF pages',
    intro: [
      'Turn the pages of a PDF the right way up. Unlike rotating the view in a PDF reader, this saves the rotation into the file itself, so it stays that way for whoever opens it next.',
      'This tool rotates every page 90° clockwise. Run it twice for 180°, three times for 270°.',
      'Scanners are the usual reason a PDF comes out sideways, particularly when a document is fed in landscape. Fixing it once here means you do not have to explain the tilt to everyone you send it to.',
      'To rotate only some pages rather than all of them, open the document in the workspace, select the pages you want, and rotate those.',
      'Rotation is stored as page metadata rather than by re-rendering the page, so the operation is fast, lossless, and adds essentially nothing to the file size. Text remains selectable and searchable at the new orientation.',
      'A common case is a document where only some pages are sideways, typically because a feeder picked up a landscape sheet mid-stack. Rotating everything would then fix half the document and break the other half, which is why per-page selection lives in the workspace.',
      'Every rotation creates a new version, so if you rotate one step too far you can revert rather than rotating three more times to get back.',
      'If the page looks rotated in one viewer but not another, the file most likely carries a rotation flag that some readers honour and others ignore. Saving the rotation here normalises it, so every reader agrees.',
    ],
    faq: [
      {
        q: 'Does the rotation stick when someone else opens the file?',
        a: 'Yes. The rotation is written into the PDF, not applied as a temporary view setting.',
      },
      {
        q: 'Can I rotate just one page?',
        a: 'On this page the rotation applies to every page. For per-page control, open the file in the workspace and select the pages you want first.',
      },
      { q: 'Do I need an account?', a: 'No.' },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Rotate PDF',
  },
  {
    slug: 'delete-pdf-pages',
    kind: 'delete-pages',
    title: 'Delete PDF pages — remove pages from a PDF free | ZenPDF',
    metaDescription:
      'Remove unwanted pages from a PDF and download the result. Free, no account, no watermark.',
    h1: 'Delete pages from a PDF',
    intro: [
      'Remove pages you do not want. Upload the document, and ZenPDF gives you a copy without the first page — or open it in the workspace to pick exactly which pages go.',
      'Deleting a page here creates a new version of the document rather than overwriting the original, so you can always go back to what you started with.',
      'This is the quickest way to drop a cover sheet, a blank page a scanner inserted, or an appendix that should not be shared.',
      'No account, no watermark, and guest files are deleted automatically within 24 hours.',
      'Deleting pages reduces the file size roughly in proportion to what was removed, since the page content itself is dropped rather than merely hidden. A page that is deleted is genuinely gone from the output file.',
      'That last point matters if the reason you are deleting a page is that it contains something private. Deletion here removes the page and its content — but if you need to remove sensitive text from a page you are keeping, that is redaction, not deletion, and it is a different tool.',
      'Because each operation creates a new version rather than overwriting, the original is still there while your session lasts. Deleting the wrong page is recoverable; you are never one click from losing the document.',
      'Page numbers printed onto the pages themselves are part of the page content, so they do not renumber when pages are removed. If the document needs consecutive numbering afterwards, add page numbers as a separate step rather than expecting the existing ones to shift.',
    ],
    faq: [
      {
        q: 'Can I get the deleted page back?',
        a: 'Yes, within your session. Every operation creates a new version and the previous ones stay available in the workspace, so you can revert.',
      },
      {
        q: 'Can I choose which pages to delete?',
        a: 'Open the file in the workspace after uploading and select exactly the pages you want to remove.',
      },
      { q: 'Is it free?', a: 'Yes, and no account is required.' },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Delete pages',
  },
  {
    slug: 'extract-pdf-pages',
    kind: 'extract-pages',
    title: 'Extract PDF pages — pull pages out of a PDF free | ZenPDF',
    metaDescription:
      'Extract pages from a PDF into a new document. Free, no account, no watermark. Files auto-delete within 24 hours.',
    h1: 'Extract pages from a PDF',
    intro: [
      'Pull pages out of a PDF into a separate document, leaving the original untouched. Useful when you need to send one section of a long file and nothing else.',
      'This page extracts the first page into a new document. To choose a different set, open the file in the workspace, select the pages, and extract from there.',
      'Extraction copies the pages rather than re-rendering them, so text stays selectable and image quality is unchanged.',
      'It works without an account. The extracted document is yours to download immediately.',
      'The extracted document is independent of the source once created. Changing one afterwards does not affect the other, so you can safely edit the extract — adding a header, redacting a figure — without touching the original.',
      'Extraction is the right tool when the pages you need are scattered through a document rather than contiguous. Pick page 2, page 9 and page 40, and they arrive in a single new file in that order.',
      'Like every other operation here, extraction copies page content rather than re-rendering it, so nothing degrades and the result is not watermarked.',
      'Form fields, annotations and links that live on an extracted page come across with it. Anything that pointed at a page you did not extract will no longer resolve, which is expected: the target is not in the new document.',
    ],
    faq: [
      {
        q: 'What is the difference between extracting and splitting?',
        a: 'Splitting turns one document into many, one per page. Extracting takes the pages you choose and puts just those into a single new document.',
      },
      {
        q: 'Does the original change?',
        a: 'No. Extraction creates a new document and leaves the source as it was.',
      },
      { q: 'Do I need to sign up?', a: 'No.' },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Extract pages',
  },
  {
    slug: 'organize-pdf',
    kind: 'organize',
    title: 'Organize PDF — reorder and manage PDF pages free | ZenPDF',
    metaDescription:
      'Reorder, rotate, duplicate and delete PDF pages by dragging them. Free, no account, no watermark.',
    h1: 'Organize PDF pages',
    intro: [
      'Rearrange a document by dragging its pages into the order you want. Upload the file here and ZenPDF opens it in the workspace, where every page is shown as a thumbnail you can move, rotate, duplicate or delete.',
      'Changes are applied to the document as new versions, so nothing is destroyed: the version history keeps every step and you can revert to any of them.',
      'This is the tool for putting a scanned document back into a sensible order, moving an appendix to the end, or removing duplicate pages a feeder picked up twice.',
      'No account is needed to organize a document. An account keeps the result in a library instead of letting it expire, which is worth having if you will come back to the file.',
      'The workspace shows the document as a grid of page thumbnails. Drag to reorder, click to select one or several, and apply rotate, duplicate, delete or extract to exactly the pages you picked.',
      'Reordering is applied optimistically — the grid updates as you drop the page — and then reconciled against the server once the operation completes. If two tabs edit the same document at once, the second one is told the document changed and reloads rather than silently overwriting the first.',
      'Everything is versioned. The history panel lists each step with a label, and reverting creates a new version that restores an earlier state rather than deleting anything, so the trail of what happened stays intact.',
      'Large documents stay responsive because thumbnails are rendered on demand and cached rather than all at once, so a 300-page file opens without waiting for every page to draw first.',
    ],
    faq: [
      {
        q: 'Can I drag pages into a new order?',
        a: 'Yes. The workspace shows every page as a thumbnail and you can drag them into position.',
      },
      {
        q: 'Can I undo a change?',
        a: 'Yes. Each operation creates a new version and the history panel lets you revert to any earlier one.',
      },
      {
        q: 'How long do my files last without an account?',
        a: 'Guest files are deleted automatically within 24 hours. With a free account they stay in your library until you delete them.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Organize PDF',
  },
  {
    slug: 'annotate-pdf',
    kind: 'annotate',
    title: 'Annotate PDF — highlight, comment and draw on a PDF free | ZenPDF',
    metaDescription:
      'Highlight text, add sticky notes, draw shapes and sign off on a PDF in your browser. Free, no account, no watermark. Files auto-delete within 24 hours.',
    h1: 'Annotate a PDF',
    intro: [
      'Mark up a document: highlight text, underline or strike it through, drop a sticky note, draw a box or an arrow, sketch freehand, and stamp it Approved. Drop the file in and the markup tools open straight away — no account, no watermark, nothing held back behind a signup form.',
      'The marks are written into the PDF as real annotations, the same kind Acrobat and Preview create. That matters more than it sounds: whoever you send the file to sees your comments in whatever reader they already use, and can reply to them there. Nothing depends on them visiting this site.',
      'Highlighting works off the document\'s own text layer, so a highlight follows the words rather than sitting in an approximate box over them. That includes right-to-left text such as Hebrew and Arabic, where each word is measured individually.',
      'Everything you draw is collected into one save, so a session of thirty comments becomes a single new version of the document rather than thirty. The version history keeps each save, and you can revert to any earlier state.',
      'When the markup is final you can flatten it. Flattening paints the annotations permanently into the page: they stop being editable objects and become part of the artwork, which is what you want before sending a signed-off copy to someone who should not be able to move your comments around. It is not reversible in the file itself — but the version before flattening is still in the history.',
      'A scanned page with no text layer can still take notes, shapes and freehand drawing; only text highlighting needs words to attach to. Run OCR on the document first if you need to highlight a scan.',
      'Without an account, files are deleted automatically within 24 hours. Creating a free account keeps them in a library instead, raises the size and page limits, and lets you send documents out for signature.',
    ],
    faq: [
      {
        q: 'Will my comments show up in Acrobat or Preview?',
        a: 'Yes. ZenPDF writes standard PDF annotations, so any conforming reader shows them — and can edit or reply to them.',
      },
      {
        q: 'What is the difference between saving and flattening?',
        a: 'Saving keeps your marks as annotations that can still be moved, edited or deleted. Flattening bakes them into the page permanently so nobody can change them. The pre-flatten version stays in your history either way.',
      },
      {
        q: 'Can I highlight text on a scanned document?',
        a: 'Not directly — a scan is an image with no text layer for a highlight to attach to. Notes, boxes, arrows and freehand drawing all work. Run OCR first if you need real text highlighting.',
      },
      {
        q: 'Who is shown as the author of my comments?',
        a: 'Your display name if you have an account, otherwise simply "Guest". Nothing identifying — no session id, no IP address — is ever written into the file.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Annotate PDF',
  },
  {
    slug: 'edit-pdf',
    kind: 'edit',
    title: 'Edit PDF — change the text in a PDF online free | ZenPDF',
    metaDescription:
      'Click a paragraph and rewrite it, add text, whiteout, swap images and fix links — in your browser, free, no account, no watermark.',
    h1: 'Edit a PDF',
    intro: [
      'Change the words that are already in a PDF. Click a paragraph, type over it, and ZenPDF rewrites that part of the page. You can also add new text anywhere, paint over something with whiteout, replace or delete images, and fix links that point at the wrong place.',
      'PDFs were never designed to be edited, and it is worth knowing what that means before you start. A PDF stores positioned glyphs, not paragraphs, so editing is block-scoped: the block you change is redrawn, and the rest of the page stays exactly where it was. Text does not reflow from one block to the next, and if your replacement is much longer than the original it will be shrunk to fit — or you will be told the size it would need, so you can widen the box instead.',
      'The replacement font is a close approximation rather than an exact match. Most PDFs embed only the characters they actually use, so the original font often physically cannot render the letters you just typed. We substitute a matching family at the same size, which looks right in body text and can be noticeable in a display font.',
      'Find and replace works in two steps on purpose. The first pass only looks: you get a list of every match with the text around it, and you untick the ones you want to keep. Only then is anything changed. Replacing 40 occurrences when you meant 3 is exactly the mistake this avoids.',
      'Scanned pages are a different problem. A scan is a photograph of text, so there is nothing to click — the editor says so and points you at OCR, which adds a real text layer the editor can then work with.',
      'Whiteout is not redaction. Painting a white box over something hides it visually, but the text is still in the file and can be copied straight back out. If you need it gone, use the redaction tool, which removes the content itself.',
      'Every change creates a new version rather than overwriting, so you can compare, revert, or take a different approach without losing what you had.',
    ],
    faq: [
      {
        q: 'Can I edit any PDF?',
        a: 'Any PDF with a real text layer. Scans are pictures of text — run OCR on them first and then the editor works normally.',
      },
      {
        q: 'Why does the font look slightly different after editing?',
        a: 'Most PDFs embed only the characters the document actually uses, so the original font often cannot draw the letters you typed. We substitute a matching family at the same size.',
      },
      {
        q: 'Why will my new text not fit?',
        a: 'Editing is block-scoped and does not reflow the page, so a longer replacement has to fit the original box. We shrink it up to a point, and past that we tell you the size that would fit so you can widen the box instead.',
      },
      {
        q: 'Is whiteout the same as redacting?',
        a: 'No. Whiteout hides content visually while leaving it in the file; anyone can copy it back out. Redaction removes the content itself.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Edit PDF',
  },
  {
    slug: 'watermark-pdf',
    kind: 'watermark',
    title: 'Watermark PDF — add a text or image watermark free | ZenPDF',
    metaDescription:
      'Stamp DRAFT, CONFIDENTIAL or your logo across a PDF. Adjustable opacity, tiling, and behind-the-text placement. Free, no account.',
    h1: 'Add a watermark to a PDF',
    intro: [
      'Mark a document as a draft, as confidential, or as yours. This page stamps a diagonal DRAFT across every page, behind the content, at a readable opacity — one click, then download.',
      'By default the watermark is drawn behind the page content rather than on top of it. That is a deliberate choice: a watermark over the text makes the document harder to read and, if it is opaque enough to be obvious, harder to use. Behind the content it is clearly visible, the text stays crisp, and the document stays searchable.',
      'Tiling repeats the mark across the whole page, which is what you want when the point is to make the document awkward to pass off as an original. A single centred mark is quieter and usually enough for an internal draft.',
      'A watermark added here is part of the page, not an overlay a reader can switch off. It is not a security feature — anyone determined can remove it with the same class of tool you are using now — but it does travel with the file and it does make provenance obvious at a glance.',
      'For anything more specific — your own wording, a logo instead of a word, a different angle, colour or opacity, tiling, or a watermark on only some pages — open the document in the workspace afterwards and use the Stamps panel, which exposes all of it.',
      'No account is needed and the result is not itself watermarked by us. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'Will the watermark cover my text?',
        a: 'Not by default — it is drawn behind the content, so the page stays readable and the text stays selectable. You can put it in front if you want it to dominate.',
      },
      {
        q: 'Can I use my logo instead of a word?',
        a: 'Yes, from the Stamps panel in the workspace: upload a PNG or JPEG and it is placed with the same opacity and tiling controls. This page does the common text case in one click.',
      },
      {
        q: 'Does a watermark stop people copying my document?',
        a: 'No. It makes provenance obvious, which is usually the real goal, but it is not a security control. To remove content permanently, use redaction; to restrict opening or printing, use the protect tool.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Add watermark',
  },
  {
    slug: 'add-page-numbers',
    kind: 'page-numbers',
    title: 'Add page numbers to a PDF online free | ZenPDF',
    metaDescription:
      'Number the pages of a PDF. Choose the position and format, start at any number, and skip the cover page. Free, no account, no watermark.',
    h1: 'Add page numbers to a PDF',
    intro: [
      'Number the pages of a document that arrived without numbers, or renumber one whose numbering no longer matches after pages were added or removed.',
      'This page numbers every page in the bottom centre — the usual answer — and hands you the file. For anything else, open the document in the workspace: the Stamps panel offers six positions, any starting number, skipping the cover page, and a format field where "Page 3 of 12" is as easy as "3".',
      'Numbering starting at any value matters more often than it sounds. A chapter that begins on page 47 of a bound report should say 47, not 1. And a cover page usually should not be numbered at all. Both are single controls in the workspace panel.',
      'The number is drawn into the page content, so it is part of the file and shows up wherever the document is opened or printed. It is not a header a reader can toggle.',
      'Numbers printed onto pages do not renumber themselves if you later add or remove pages — they are content, not a field. Reorder first, number second, and if the document changes afterwards just number it again from the version before.',
      'Free, no account, and nothing is watermarked. A running header or footer and Bates numbering for legal work are in the same Stamps panel.',
    ],
    faq: [
      {
        q: 'Can I skip the cover page?',
        a: 'Yes, from the Stamps panel in the workspace — one checkbox. Numbering then starts on the second page, and you choose what number it starts at. This page numbers every page.',
      },
      {
        q: 'Can I write "Page 3 of 12"?',
        a: 'Yes, in the workspace: the format field accepts tokens for the page number, the total page count and the date, mixed with any text you like.',
      },
      {
        q: 'Will the numbers update if I add pages later?',
        a: 'No. They are drawn into the page, not calculated on the fly. Add or remove pages first, then number — or revert to the version before numbering and number it again.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Add page numbers',
  },
  {
    slug: 'fill-pdf-form',
    kind: 'fill-form',
    title: 'Fill out a PDF form online free — no account | ZenPDF',
    metaDescription:
      'Fill in a PDF form in your browser and save the answers into the file. Flatten it so nobody can change them. Free, no account, no watermark.',
    h1: 'Fill out a PDF form',
    intro: [
      'Open a PDF form, type into the fields, and save your answers into the file itself. The document you download is a normal PDF that shows your answers in Acrobat, Preview, or whatever the person on the other end happens to use.',
      'That is the part most "fill a PDF" tools get wrong. Printing the form, writing on it and scanning it back turns a crisp document into a photograph of one; typing into an overlay that only exists on a website leaves you with a file whose values disappear elsewhere. Here the values are written into the form fields, which is where a PDF form keeps them.',
      'Every kind of field a PDF form can have works: text boxes, checkboxes, radio groups where choosing one option clears the others, drop-down lists and multi-choice lists. Fields marked read-only by whoever made the form stay read-only, because a form that lets you edit a locked field is lying to you.',
      'When you are finished you can flatten the form. Flattening prints your answers onto the page and removes the fields, so the values can no longer be changed — the right final step before sending a completed form back. It cannot be undone in the file, but the version before flattening stays in your history.',
      'You can also export what you typed as JSON or CSV, and import it back into the same form later — or into next year\'s copy of it. Filling in the same 30-field form every quarter is exactly the kind of thing a computer should be doing for you.',
      'If the document has no form fields at all, you can add them: drag a box on the page, pick a field type, name it, and save. That is the same builder used to turn a flat questionnaire into something people can actually type into.',
      'One honest limitation: XFA forms — a legacy Adobe format that stores the form as XML rather than as PDF fields — are not supported. We detect them and say so, rather than showing you a half-rendered fallback and letting you discover later that your answers went nowhere.',
      'No account is needed and nothing is watermarked. Guest files are deleted automatically within 24 hours; a free account keeps them in a library instead.',
    ],
    faq: [
      {
        q: 'Will my answers show up if I open the file in Acrobat?',
        a: 'Yes. The values are written into the PDF\'s own form fields, so any conforming reader shows them. Flatten the form if you want them printed onto the page permanently.',
      },
      {
        q: 'What is flattening, and should I do it?',
        a: 'Flattening bakes the values into the page and removes the fields, so nobody can change your answers afterwards. It is the usual last step before sending a completed form back. The version before flattening stays in your history.',
      },
      {
        q: 'The form will not let me type in a field.',
        a: 'That field is marked read-only by whoever created the form. We honour that rather than letting you fill in something the recipient\'s software will ignore.',
      },
      {
        q: 'My PDF has no fields to fill in.',
        a: 'Then it is a flat document that looks like a form. Use the form builder to draw the fields onto it — text boxes, checkboxes, radio groups and lists — and it becomes fillable.',
      },
      {
        q: 'Can I reuse the answers on another copy of the same form?',
        a: 'Yes. Export the data as JSON or CSV, then import it into the other copy. Fields are matched by name.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Fill out form',
  },
  {
    slug: 'ocr-pdf',
    kind: 'ocr',
    title: 'OCR PDF — make a scanned PDF searchable, free | ZenPDF',
    metaDescription:
      'Turn a scanned PDF into text you can search, select and copy. English, Hebrew, German, French and Spanish. Free, no account, no watermark.',
    h1: 'Make a scanned PDF searchable',
    intro: [
      'A scanned document is a photograph of a page. It looks like text to you and is a picture to every computer that handles it: you cannot search it, select a sentence, copy a figure out of it, or edit a word. OCR fixes that by reading the picture and writing what it says into the file as an invisible text layer.',
      'The page itself is left exactly as it is. Nothing is redrawn, no font is substituted, and the document still looks like the scan you started with — the text layer sits behind the image, lined up with the words, which is why selecting a line highlights the right pixels.',
      'Five languages ship ready to use: English, Hebrew, German, French and Spanish. Hebrew and other right-to-left scripts come back in the correct reading order, which is the part naive OCR usually gets wrong.',
      'Three optional clean-up passes are available in the workspace: straightening a crooked scan, turning sideways pages the right way up, and removing speckles before reading. They help a photographed page and can slightly blur an already-clean one, so they are off by default.',
      'A PDF that already has real text is left alone by default. Re-reading a picture of text you already have is a downgrade, not an improvement, so replacing an existing text layer is something you have to ask for explicitly.',
      'Accuracy depends on the scan. Three hundred DPI, straight, and in focus reads almost perfectly; a photograph taken at an angle in poor light will have mistakes. We do not pretend otherwise — check anything that matters, particularly numbers.',
      'Once a document has been through OCR the rest of ZenPDF opens up for it: the editor will let you change the text, find and replace works, and highlighting attaches to real words instead of guessing.',
      'Free, no account, and nothing watermarked. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'Does OCR change how my document looks?',
        a: 'No. The page image is untouched; the recognised text goes in as an invisible layer behind it, aligned with the words.',
      },
      {
        q: 'Which languages are supported?',
        a: 'English, Hebrew, German, French and Spanish are installed. Pick more than one if a document mixes them.',
      },
      {
        q: 'Will it be perfect?',
        a: 'On a clean 300 DPI scan it is very close. On a phone photo taken at an angle it will make mistakes — check anything that matters, especially numbers.',
      },
      {
        q: 'My PDF already has text. Should I run OCR?',
        a: 'No, and by default we skip those pages. Replacing real text with a reading of a picture of it makes the document worse.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Run OCR',
  },
  {
    slug: 'pdf-to-word',
    kind: 'pdf-to-word',
    title: 'PDF to Word — convert PDF to editable DOCX free | ZenPDF',
    metaDescription:
      'Convert a PDF into an editable Word document. Free, no account, no watermark. Files auto-delete within 24 hours.',
    h1: 'Convert PDF to Word',
    intro: [
      'Turn a PDF into a .docx you can open and edit in Word, Google Docs, LibreOffice or Pages. Drop the file in and the converted document downloads straight away.',
      'It is worth knowing what this conversion actually does, because every tool that offers it is doing the same difficult thing. A PDF does not contain paragraphs, headings, tables or columns — it contains glyphs at coordinates. Converting to Word means *reconstructing* a document structure that was never there, by looking at where things sit on the page and inferring what they were.',
      'That reconstruction is good on straightforward documents: a letter, a report, a contract in a single column comes across with its paragraphs, its bold, and usually its tables intact. It is weaker on complex layouts — magazine columns, heavy use of text boxes, forms with ruled lines — where the inferred structure will need tidying.',
      'Scanned PDFs are a different matter entirely. There are no glyphs to work from, only pixels, so the result would be a Word document containing one large picture. Run OCR first and the conversion has real text to work with.',
      'The original PDF is untouched. Converting produces a new file to download; nothing about the document in your library changes.',
      'No account is needed and the result is not watermarked. For the reverse direction — a Word file into a PDF — use the Word to PDF tool.',
      'Downloads are kept for 24 hours and then deleted, along with the file you uploaded if you are working without an account.',
    ],
    faq: [
      {
        q: 'Will the layout be identical?',
        a: 'Close on simple documents, approximate on complex ones. A PDF has no paragraphs to recover — the structure is inferred from where things sit on the page.',
      },
      {
        q: 'Can I convert a scanned PDF to Word?',
        a: 'Run OCR on it first. Without a text layer there is nothing to convert but pixels, and you would get a Word file containing a picture.',
      },
      {
        q: 'Is the converted file editable?',
        a: 'Yes — it is a real .docx with editable text, not an image in a wrapper.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Convert to Word',
  },
  {
    slug: 'word-to-pdf',
    kind: 'word-to-pdf',
    title: 'Word to PDF — convert DOCX to PDF online free | ZenPDF',
    metaDescription:
      'Convert Word, Excel, PowerPoint, OpenDocument and RTF files to PDF. Free, no account, no watermark, fonts and layout preserved.',
    h1: 'Convert Word to PDF',
    intro: [
      'Turn a Word document into a PDF that looks the same everywhere. Drop the .docx in and download the PDF — no account, no watermark, no email address.',
      'The conversion runs through LibreOffice, which reads the file the way an office suite does rather than guessing at the XML: styles, headers and footers, page breaks, tables, images and embedded fonts all come across. What you see in Word is what lands in the PDF, within the ordinary limits of two different rendering engines.',
      'Other office formats work through the same route: .doc, .odt and .rtf for text; .xlsx, .ods and .csv for spreadsheets; .pptx and .odp for slides. Plain .txt too, which is occasionally the quickest way to get a clean, printable page.',
      'Converting to PDF is what to do before sending a document to someone who should not edit it, or who might not have the fonts you used. A PDF carries its fonts with it; a Word file trusts the recipient to have them, and substitutes silently when they do not.',
      'The result opens in the workspace if you want to keep working — add a watermark, number the pages, protect it with a password, or sign it — or you can simply download it and close the tab.',
      'Very large or unusual documents can take a few seconds; the conversion runs on our servers and the result is checked to be a readable PDF before it is handed back, so a broken conversion is reported as one rather than downloaded as a file that will not open.',
      'Guest files are deleted automatically within 24 hours. A free account keeps them in a library instead and raises the size limits.',
    ],
    faq: [
      {
        q: 'Will my formatting survive?',
        a: 'Yes, in almost all cases. The conversion uses LibreOffice, so styles, tables, headers, images and embedded fonts are handled properly rather than approximated.',
      },
      {
        q: 'What file types can I convert?',
        a: 'Word (.doc, .docx), OpenDocument (.odt, .ods, .odp), RTF, plain text, Excel (.xls, .xlsx), CSV and PowerPoint (.ppt, .pptx).',
      },
      {
        q: 'Do I need Microsoft Word installed?',
        a: 'No. The conversion happens on our servers; you need nothing but a browser.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Convert to PDF',
  },
  {
    slug: 'jpg-to-pdf',
    kind: 'jpg-to-pdf',
    title: 'JPG to PDF — convert images to PDF online free | ZenPDF',
    metaDescription:
      'Turn JPG, PNG or TIFF images into a PDF. Multi-page TIFFs keep every page. Free, no account, no watermark.',
    h1: 'Convert images to PDF',
    intro: [
      'Turn photographs and scans into a PDF — one page per image, in the order you add them. JPG, PNG, TIFF, BMP, GIF and WebP all work.',
      'A multi-page TIFF, which is what a lot of office scanners and fax gateways produce, keeps every one of its frames: a twelve-page scan becomes a twelve-page PDF rather than a PDF of its first page. This is the case most image-to-PDF converters quietly get wrong.',
      'Images are fitted to A4 by default, centred and scaled to keep their proportions, which is what you want for something that will be printed or filed. The workspace also offers original size, where each page matches its image exactly — better for screenshots and for images that are already the right shape.',
      'Photographs of documents are worth a second step: run OCR afterwards and the text in the picture becomes searchable and selectable, which turns a photo of a receipt into something you can actually find later.',
      'The image data is embedded as-is rather than re-encoded, so nothing is degraded on the way in. A PDF of photographs is a large file by nature; compress it afterwards if it needs to fit an email.',
      'No account, no watermark, and nothing is sent to a third party. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'Can I combine several images into one PDF?',
        a: 'Yes — add them all and each becomes a page, in the order you added them.',
      },
      {
        q: 'Does a multi-page TIFF keep all its pages?',
        a: 'Yes. Every frame becomes a page.',
      },
      {
        q: 'Are my images re-compressed?',
        a: 'No. The image data is embedded as it arrived, so nothing is degraded. Use the compress tool afterwards if the file needs to be smaller.',
      },
    ],
    minFiles: 1,
    multiple: true,
    cta: 'Convert to PDF',
  },
  {
    slug: 'pdf-to-jpg',
    kind: 'pdf-to-jpg',
    title: 'PDF to JPG — convert PDF pages to images free | ZenPDF',
    metaDescription:
      'Convert every page of a PDF into a JPG or PNG image at the resolution you choose. Free, no account, no watermark.',
    h1: 'Convert PDF to images',
    intro: [
      'Turn each page of a PDF into an image. You get a zip containing one file per page, numbered in order, ready to drop into a slide deck, a web page or a chat message.',
      'A zip rather than a single image on purpose: a document has more than one page, and a tool that silently converts only the first is a tool that has wasted your time. Ten pages give you ten files.',
      'Resolution is yours to choose in the workspace, from 72 DPI for something that will only ever be looked at on a screen up to 300 DPI for print. Higher DPI means a sharper image and a much larger file — 300 DPI is roughly seventeen times the pixels of 72.',
      'JPEG and PNG are both available. JPEG is smaller and right for pages that are mostly photographs; PNG is lossless and right for pages of text and diagrams, where JPEG artefacts show up as fuzz around the letters.',
      'Converting to images is a one-way door: the result is pixels, with no text layer, so nothing in it can be searched, selected or edited afterwards. That is sometimes exactly what you want — an image of a page cannot be copied out of or reflowed — but it is worth knowing before you send the result to someone who may need the text.',
      'The original PDF is untouched. Free, no account, and the zip is kept for 24 hours before it is deleted.',
    ],
    faq: [
      {
        q: 'Do I get one image or one per page?',
        a: 'One per page, delivered as a zip, numbered in page order.',
      },
      {
        q: 'What resolution should I choose?',
        a: '72–150 DPI for anything that will be viewed on a screen, 300 DPI for print. Higher means sharper and much bigger.',
      },
      {
        q: 'Can I get the text back afterwards?',
        a: 'Not from the images — they are pixels. Keep the original PDF, or run OCR on the images if the original is gone.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Convert to images',
  },
  {
    slug: 'html-to-pdf',
    kind: 'html-to-pdf',
    title: 'HTML to PDF — convert a web page or HTML file to PDF | ZenPDF',
    metaDescription:
      'Convert an HTML file into a PDF, rendered by a real browser engine. Free, no account, no watermark.',
    h1: 'Convert HTML to PDF',
    intro: [
      'Turn an HTML file into a PDF that looks the way the page looks. The conversion runs through a real Chromium browser, so CSS, web fonts, flexbox and grid layouts, SVG and print stylesheets are all handled properly rather than approximated by a converter with its own idea of HTML.',
      'This is the right tool for an invoice or a report your system generates as HTML, for an email you have saved, or for documentation you want to archive as a fixed, printable file.',
      'If the page has a print stylesheet, that is what you get — the same layout a browser would send to a printer, without the navigation and the cookie banner.',
      'Upload an HTML file and any styles that are inlined or embedded in it are applied. A page that pulls its stylesheet from elsewhere on the web will render unstyled, so save the complete page if you want it to look right.',
      'The result is a normal PDF: searchable, selectable, and ready for anything else here — sign it, number the pages, protect it, or merge it into a larger document.',
      'Page size and margins follow the page\'s own print rules. An HTML document that says nothing about printing gets sensible A4 defaults; one with a print stylesheet gets exactly what that stylesheet asks for, including page breaks you have placed deliberately.',
      'Converting by address rather than by file is available from the import box in your library. It is deliberately restricted: addresses that resolve inside a private network are refused, because a converter that will fetch any address on request is a tool for reading things it should not.',
      'Free, no account, and nothing watermarked. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'Does it handle modern CSS?',
        a: 'Yes. Rendering is done by Chromium, so what a browser shows is what the PDF contains — including flexbox, grid, web fonts and SVG.',
      },
      {
        q: 'Why does my page look unstyled?',
        a: 'Most likely its stylesheet lives at another address that the uploaded file cannot reach. Save the complete page, with its styles inlined or embedded, and convert that.',
      },
      {
        q: 'Can I convert a page by URL?',
        a: 'Yes, from the import box in your library. For safety, addresses inside private networks are refused.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Convert to PDF',
  },
  {
    slug: 'compare-pdf',
    kind: 'compare',
    title: 'Compare PDF — find the differences between two PDFs free | ZenPDF',
    metaDescription:
      'Compare two PDFs side by side and see exactly what changed — added, removed and rewritten text, plus visual differences. Free, no account.',
    h1: 'Compare two PDFs',
    intro: [
      'Put two versions of a document next to each other and see what actually changed. Every added, removed and rewritten passage is listed; clicking one moves both sides to that page and highlights it where it sits.',
      'Two comparisons run, because they catch different things. The text comparison aligns the words of each page and reports the differences precisely — the wording, not an approximation of it. The visual comparison renders both pages and finds regions of pixels that differ, which catches everything the text pass cannot see: a moved figure, a changed logo, a redaction box, a different chart.',
      'That second pass matters more than it sounds. A clause deleted from a contract and a signature block quietly moved are both "changes", and only one of them involves any words changing.',
      'Pages are matched by position, with an offset control for the common case where one side gained or lost a page near the front. Set the offset to one and page one is compared with page two, and so on down the document.',
      'Small rendering noise — anti-aliasing, a fraction of a millimetre of drift — is ignored, so a page that is genuinely unchanged is reported as unchanged rather than as a scatter of meaningless boxes.',
      'Scanned documents can be compared visually, but their text cannot be compared until they have been through OCR: there is nothing to align. Run OCR on both sides first and the text comparison works normally.',
      'Both documents stay exactly as they were. Comparing reads them and produces a report; it never writes anything back.',
      'Free, no account, and no watermark. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'What kinds of change does it find?',
        a: 'Added, removed and rewritten text, reported word by word — plus visual differences, which catch changes that involve no text at all, such as a moved image or a redaction.',
      },
      {
        q: 'The pages do not line up. What do I do?',
        a: 'Use the page offset. If one side gained a cover page, set the offset to 1 so page 1 is compared with page 2.',
      },
      {
        q: 'Can I compare scanned documents?',
        a: 'Visually, yes. For a text comparison, run OCR on both first — a scan has no text to align.',
      },
      {
        q: 'Does comparing change my files?',
        a: 'No. Both documents are read and left exactly as they were.',
      },
    ],
    minFiles: 2,
    multiple: true,
    cta: 'Compare PDFs',
  },
  {
    slug: 'repair-pdf',
    kind: 'repair',
    title: 'Repair PDF — fix a damaged or corrupted PDF file free | ZenPDF',
    metaDescription:
      'Rebuild a damaged PDF so it opens again. Free, no account, no watermark. Files auto-delete within 24 hours.',
    h1: 'Repair a damaged PDF',
    intro: [
      'A PDF that will not open, or that opens with an error, is usually not lost. Most damage is to the file\'s index rather than to its content: the pages, text and images are still in there, and what has gone wrong is the table that says where they are.',
      'Repair rebuilds that structure. The file is read with error recovery, every object that can be found is recovered, the cross-reference table is rebuilt from scratch, and the result is written out cleanly.',
      'The usual causes are an interrupted download, a copy that stopped halfway, a crash while saving, or a transfer that mangled line endings. All of those damage the wrapper rather than the contents, which is why recovery works as often as it does.',
      'What repair cannot do is invent content that is not there. If a file was truncated at 60% of its length, the last 40% of the pages are genuinely gone — you will get back everything that survived, which is usually better than nothing but is not the whole document.',
      'The same recovery runs automatically when you upload a damaged file: rather than refusing it, we offer to repair it on the way in. This page is for a file already in your library that has started misbehaving, or one you would rather clean up before sending on.',
      'Repairing also tidies a file that opens perfectly well — normalising object streams and rebuilding the index often makes a bloated PDF noticeably smaller. Every repair creates a new version, so the original is still there if you preferred it.',
      'Free, no account, and no watermark.',
    ],
    faq: [
      {
        q: 'Can you recover any damaged PDF?',
        a: 'Most of them. Damage is usually to the index rather than the content, and that can be rebuilt. A file truncated halfway has genuinely lost the rest — you get back what survived.',
      },
      {
        q: 'Will repairing change my document?',
        a: 'The pages, text and images are preserved. The internal structure is rewritten, which often makes the file smaller.',
      },
      {
        q: 'My file will not even upload.',
        a: 'Upload it anyway — a damaged file is offered a repair pass on the way in rather than being rejected.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Repair PDF',
  },
  {
    slug: 'protect-pdf',
    kind: 'protect',
    title: 'Protect PDF — add a password and restrictions free | ZenPDF',
    metaDescription:
      'Put a password on a PDF and set what readers may print, copy or change. AES-256 encryption, free, no account. Files auto-delete within 24 hours.',
    h1: 'Password-protect a PDF',
    intro: [
      'Add a password to a PDF so that only the people you give it to can open it. The document is encrypted with AES-256, the strongest scheme the PDF format defines, and the encryption travels with the file: it stays protected wherever it is sent, opened or stored.',
      'There are two different passwords, and the difference matters. The open password is the one a reader needs to see the document at all — without it, the file is unreadable, and that is real cryptography rather than a request. The owner password is the one that lifts the restrictions afterwards. We require an owner password and leave the open password optional, so you can choose between "nobody may read this" and "anyone may read it, but only I may change it".',
      'The restrictions are the second half. You can allow full printing, allow only low-resolution printing, or forbid it; you can allow free editing, comments and form-filling, form-filling alone, or no changes at all; and you can allow or refuse copying text and images out. These are flags a reader\'s software is asked to respect. Well-behaved viewers do respect them, and a determined person with the right tool can ignore them — so treat them as a clear statement of intent, not as a lock. The open password is the lock.',
      'One permission is never restricted: accessibility. A PDF a screen reader cannot open excludes its reader for no security gain, so we always leave that on, whatever else you choose.',
      'Keep the owner password somewhere safe. It is not stored anywhere on our side — that is the point — and without it, nobody, including us, can lift the restrictions again.',
      'Free, no account, and no watermark. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'What encryption do you use?',
        a: 'AES-256 with revision 6, the strongest the PDF specification defines. It is applied by qpdf, the same open-source library the industry uses.',
      },
      {
        q: 'What is the difference between the two passwords?',
        a: 'The open password is needed to read the document at all. The owner password is needed to change the restrictions. You must set an owner password; the open password is optional.',
      },
      {
        q: 'Can the restrictions really stop someone printing?',
        a: 'They stop ordinary readers using ordinary software. They are flags that viewers are asked to honour, and a determined person can bypass them. If a document must not be read, give it an open password.',
      },
      {
        q: 'Do you keep my password?',
        a: 'No. It is used to encrypt the file and then dropped — it is never written to your document record, and it is removed from the job as soon as the job finishes.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Protect PDF',
  },
  {
    slug: 'unlock-pdf',
    kind: 'unlock',
    title: 'Unlock PDF — remove a password from a PDF you own | ZenPDF',
    metaDescription:
      'Remove the password from a PDF you can already open, so it opens without one. Free, no account. Files auto-delete within 24 hours.',
    h1: 'Remove a password from a PDF',
    intro: [
      'If you have a PDF that asks for a password every time you open it, and you know that password, this removes it. Upload the file, type the password once, and you get back the same document with the encryption stripped off.',
      'This is not password recovery, and it is worth being plain about that: you have to know the password. There is no way to open an AES-256 encrypted PDF without it — that is what the encryption is for — and any site claiming otherwise is either guessing common passwords or lying. We do not attempt to guess, and after five wrong attempts on the same document in a minute we stop accepting them for a while.',
      'The usual reason to do this is that the protection has outlived its purpose. A bank statement arrives encrypted with your date of birth, a payslip with your employee number, a contract with a password the sender emailed you separately. Once the file is in your own storage the password is friction rather than security, and typing it every time is the friction.',
      'A document with an owner password but no open password is a different case: it opens for anyone but refuses printing or copying. That, too, is removed here, and the same rule applies — you need the owner password to lift the restrictions.',
      'Removing the password saves a new, unprotected version. The earlier, encrypted version is still in the document\'s history, so nothing is lost if you change your mind. If you want to put a password back, use the protect tool.',
      'Free, no account, and no watermark. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'Can you unlock a PDF if I have forgotten the password?',
        a: 'No. AES-256 encryption cannot be undone without the password, and we do not try to guess it. If you have lost it, ask whoever sent you the file.',
      },
      {
        q: 'Is it legal to remove a password?',
        a: 'From a document you own or are entitled to use, yes — you are removing your own protection. Do not use it on a document you are not entitled to.',
      },
      {
        q: 'What happens to the password I type?',
        a: 'It is used to open the file and then discarded. It is never saved on the document, and it is stripped from the job record as soon as the job finishes.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Unlock PDF',
  },
  {
    slug: 'redact-pdf',
    kind: 'redact',
    title: 'Redact PDF — permanently remove text and images free | ZenPDF',
    metaDescription:
      'Black out text, images and personal data in a PDF so the content is deleted, not merely covered. Free, no account. Files auto-delete within 24 hours.',
    h1: 'Redact a PDF',
    intro: [
      'Redaction removes content from a PDF. That sounds obvious, and it is the single most misunderstood thing about PDFs: drawing a black rectangle over a paragraph does not delete the paragraph. It is still in the file, underneath, and anyone can select it, copy it out, or extract it with a script. Documents have been published that way by governments, law firms and newspapers.',
      'This tool deletes it. The glyphs are removed from the page\'s content stream, and any image the rectangle touches has those pixels destroyed rather than covered. When it is done, the document is re-read and searched again to confirm that what you asked to remove is genuinely no longer findable, and the result of that check is reported back to you.',
      'There are two ways to say what goes. You can draw areas directly on the page, which is the only approach that works on a scan or on text that has been converted to outlines. Or you can search: pick a preset for email addresses, phone numbers, social security numbers, card numbers or IBANs, type words to remove, or write your own pattern. A search always shows you what it found first, with every match listed and individually removable from the list, before anything is touched.',
      'Pattern search finds text. Anything scanned, photographed or drawn as an outline has no text to find — run OCR on it first, or cover it with an area. The tool tells you when it still finds something after redacting, which is the honest answer to a problem that cannot be fully solved automatically.',
      'By default the result goes into a new document rather than a new version of this one, and that default is deliberate. Version history keeps every earlier version — and those earlier versions still contain exactly what you have just removed. A new document has no history to leak.',
      'Redaction cannot be undone. That is the point of it, and it is why the tool asks you to confirm by name.',
      'Free, no account, and no watermark. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'Is this different from drawing a black box?',
        a: 'Completely. A black box covers text that is still in the file and still copyable. Redaction deletes the text and the image pixels underneath, and then checks that they are gone.',
      },
      {
        q: 'Can I redact a scanned document?',
        a: 'Yes, by drawing areas over the parts to remove — the image pixels are destroyed. Searching will not work on a scan until you OCR it, because there is no text to search.',
      },
      {
        q: 'Why does it want to make a new document?',
        a: 'Because this document\'s earlier versions still contain what you removed. A new document starts with no history, which is the only way to say the content is really gone.',
      },
      {
        q: 'Can I undo a redaction?',
        a: 'No. The content is deleted. If you kept the result in the same document you can revert to an earlier version, which is exactly the leak the new-document default avoids.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Redact PDF',
  },
  {
    slug: 'sign-pdf',
    kind: 'sign',
    title: 'Sign PDF — add your signature to a document free | ZenPDF',
    metaDescription:
      'Draw, type or upload your signature and place it on a PDF. Free, no account, no watermark. Files auto-delete within 24 hours.',
    h1: 'Sign a PDF',
    intro: [
      'Put your signature on a document. Draw it with a finger, a stylus or the mouse, type your name in a handwriting face, or photograph one you have already signed on paper — then click where it goes and download the result.',
      'You do not need an account to sign something yourself. The signature you draw is kept in this browser for the session and nowhere else; close the tab and it is gone. A free account keeps it for next time, which is the only difference.',
      'Signing flattens the signature into the page. That matters: an image that sits on top as an annotation can be dragged off, deleted, or simply not printed by some viewers. Once applied it is part of the page, like ink. The version before it stays in the document history if you change your mind.',
      'If somebody *else* needs to sign — a client, a tenant, a co-founder — that is a different job, and it needs a free account: we email them a personal link, they agree to sign electronically, they sign in their own browser, and when everyone is done the finished document is sealed and a certificate of completion records who did what, when, and from where. That certificate is what makes an electronic signature worth having in a disagreement.',
      'What we do is a simple electronic signature with a platform seal — the same thing Documenso and DocuSeal do, and the same thing most business agreements are signed with. It is not a qualified electronic signature (QES), which requires a government-accredited identity check, and we do not claim otherwise anywhere.',
      'Free, no account, and no watermark. Guest files are deleted automatically within 24 hours.',
    ],
    faq: [
      {
        q: 'Is an electronic signature legally binding?',
        a: 'In most places, for most agreements, yes — the U.S. ESIGN Act and UETA, and the EU\'s eIDAS "simple" tier, all recognise them. Some documents (wills, some property transfers) still need paper or a notary. If it matters, ask a lawyer about your specific document.',
      },
      {
        q: 'Do I need an account?',
        a: 'Not to sign a document yourself. Sending one to somebody else for signature does need a free account, because we have to be able to say who sent it.',
      },
      {
        q: 'Can the signature be removed afterwards?',
        a: 'Not from the page — it is flattened into the content. Your own copy keeps the earlier version in its history, so you can go back if you signed the wrong thing.',
      },
      {
        q: 'What happens to my signature image?',
        a: 'Without an account it lives in your browser for the session and in temporary storage that is deleted within 24 hours. With an account it is saved to your signature library until you delete it.',
      },
    ],
    minFiles: 1,
    multiple: false,
    cta: 'Sign PDF',
  },
];

export const TOOL_SLUGS = TOOL_PAGES.map((t) => t.slug);

export function toolBySlug(slug: string): ToolPageDef | undefined {
  return TOOL_PAGES.find((t) => t.slug === slug);
}
