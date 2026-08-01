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
  | 'fill-form';

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
];

export const TOOL_SLUGS = TOOL_PAGES.map((t) => t.slug);

export function toolBySlug(slug: string): ToolPageDef | undefined {
  return TOOL_PAGES.find((t) => t.slug === slug);
}
