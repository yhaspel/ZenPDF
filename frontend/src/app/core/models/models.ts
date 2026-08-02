// API models — mirror the DRF serializers (01-architecture.md §6, §9).

export interface User {
  id: string;
  email: string;
  display_name: string;
  email_verified: boolean;
  accepted_tos_at: string | null;
  storage_bytes_used: number;
  date_joined: string;
}

export interface AuthTokens {
  access: string;
  refresh: string;
  /** Present when a guest session was claimed inline on login (§21.5). */
  claimed?: ClaimSummary;
  claim_error?: { code: string; message: string; details: Record<string, unknown> };
}

export interface VersionRef {
  id: string;
  seq: number;
  label: string;
}

export type DocStatus = 'ready' | 'processing' | 'error';

export interface DocumentModel {
  id: string;
  title: string;
  status: DocStatus;
  page_count: number;
  size_bytes: number;
  is_encrypted: boolean;
  starred: boolean;
  folder: string | null;
  metadata: Record<string, unknown>;
  current_version: VersionRef | null;
  last_opened_at: string | null;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentVersion {
  id: string;
  seq: number;
  label: string;
  size_bytes: number;
  page_count: number;
  sha256: string;
  created_by: string | null;
  job_type: string | null;
  created_at: string;
}

export interface Folder {
  id: string;
  name: string;
  parent: string | null;
  created_at: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface Job {
  id: string;
  type: string;
  document: string | null;
  status: JobStatus;
  progress: number;
  params: Record<string, unknown>;
  base_version_seq: number | null;
  error_code: string;
  error_message: string;
  /** Structured half of the §6 error shape — e.g. `text_overflow`'s
   *  `fits_at_size`, which the editor turns into an offer. */
  error_details: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** The current principal's resolved tier limits (§16). */
export interface TierLimits {
  tier: 'guest' | 'free' | 'pro';
  storage_mb: number;
  max_upload_mb: number;
  max_image_upload_mb: number;
  max_pages: number;
  max_concurrent_jobs: number;
  metered_ops_per_hour: number;
  ocr_pages_per_day: number;
  ocr_pages_per_month: number;
  sign_requests_per_month: number;
  version_retention: number;
  library: boolean;
  ads: boolean;
}

/** Present only when the caller is a guest principal (§21.2). */
export interface GuestState {
  id?: string;
  expires_at?: string;
  seconds_remaining?: number;
  storage_bytes_used?: number;
}

export interface AppConfig {
  principal: 'guest' | 'user' | 'none';
  limits: TierLimits;
  guest: GuestState;
  features: {
    ads_enabled: boolean;
    presigned_delivery: boolean;
    guest_access_enabled: boolean;
    captcha_enabled: boolean;
  };
  guest_ttl_hours: number;
  turnstile_site_key: string;
  /** `{enabled: false}` and nothing else when ads are off — no client id, no
   *  slot ids — so a build with the flag off cannot load anything (§9A). */
  ads: {
    enabled: boolean;
    provider?: string;
    client_id?: string;
    slots?: Record<string, string>;
  };
  consent_required: boolean;
  retention: { guest_hours: number; trash_days: number; export_hours: number };
}

export interface Usage {
  period: string;
  principal: 'guest' | 'user' | 'none';
  tier: string;
  storage: { used_bytes: number; quota_bytes: number };
  counters: {
    sign_requests: number;
    ocr_pages: number;
    conversions: number;
    heavy_ops: number;
    metered_ops_this_hour: number;
  };
  limits: TierLimits;
  session?: { expires_at: string; seconds_remaining: number };
}

/** Result of a claim-on-signup (§21.5). */
export interface ClaimSummary {
  documents: number;
  jobs: number;
  bytes: number;
  current_version_bytes: number;
  already_claimed: boolean;
}

export interface SearchHit {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutlineItem {
  level: number;
  title: string;
  page: number;
}

// --- Phase 3: annotations (PDF-native, §10 `annotate_batch`) --------------- //

export type AnnotationType =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'free_text'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'polygon'
  | 'polyline'
  | 'ink'
  | 'stamp'
  | 'image_stamp';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Annotation {
  /** Client-generated UUID → the PDF `/NM` key, stable across save cycles. */
  id: string;
  page: number;
  type: AnnotationType;
  rect?: Rect;
  quads?: Rect[];
  ink?: [number, number][][];
  vertices?: [number, number][];
  color?: string | null;
  fill?: string | null;
  opacity?: number;
  width?: number;
  contents?: string;
  author?: string;
  created?: string;
  modified?: string;
  icon?: string;
  font_size?: number;
  align?: number;
  stamp_name?: string;
  image_ref?: string;
}

export interface AnnotationOp {
  action: 'add' | 'update' | 'delete';
  annotation: Annotation | { id: string };
}

export interface WordBox {
  i: number;
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  b: number;
  l: number;
  n: number;
}

export interface PageWords {
  page: number;
  width: number;
  height: number;
  rotation: number;
  has_text: boolean;
  words: WordBox[];
}

/** An ephemeral uploaded image (§13 `uploads/…`) — stamps, watermarks, signatures. */
export interface ImageAsset {
  ref: string;
  width: number;
  height: number;
  content_type: string;
}

export interface ApiError {
  error: { code: string; message: string; details: Record<string, unknown> };
}


// --- Phase 4: content editing (§10) --------------------------------------- //

export interface TextSpan {
  text: string;
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  bbox: Rect;
}

export interface TextLine {
  bbox: Rect;
  spans: TextSpan[];
}

export interface TextBlock {
  block_id: number;
  bbox: Rect;
  lines: TextLine[];
  text: string;
}

export interface PageTextBlocks {
  page: number;
  width: number;
  height: number;
  rotation: number;
  /** A page of pixels has nothing to click — the editor gates on this. */
  is_scanned_page: boolean;
  blocks: TextBlock[];
}

export interface PageImage {
  xref: number;
  width: number;
  height: number;
  bbox: Rect;
}

export interface PageLink {
  index: number;
  bbox: Rect;
  kind: 'uri' | 'page' | 'other';
  uri?: string;
  page?: number;
}

export interface TextStyle {
  font_family?: 'helvetica' | 'sans-serif' | 'times' | 'serif' | 'courier' | 'monospace';
  size?: number;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  bold?: boolean;
  italic?: boolean;
}

/** One hit from a `find_replace` dry run, for the review list. */
export interface ReplaceMatch {
  id: string;
  page: number;
  rect: Rect;
  context: string;
}

export interface ReplaceReport {
  query: string;
  count: number;
  matches: ReplaceMatch[];
  replaced: number;
  dry_run: boolean;
}

// --------------------------------------------------------------------------- //
// Phase 5 — forms
// --------------------------------------------------------------------------- //
export type FormFieldType =
  | 'text' | 'checkbox' | 'radio' | 'combobox' | 'listbox' | 'signature';

/** One placement of a field. A radio group has one per option. */
export interface FormWidget {
  page: number;
  rect: Rect;
  on_value: string;
}

export interface FormField {
  name: string;
  type: FormFieldType;
  page: number;
  rect: Rect;
  value: string;
  /** `/DV` — what "reset form" would put back. */
  default: string;
  /** `/Q` — so the property panel prefills what the field actually has. */
  align: 'left' | 'center' | 'right';
  /** `/DA`'s size. 0 means "auto", which is PDF for "fit the box". */
  font_size: number;
  options: string[];
  flags: { required: boolean; readonly: boolean; multiline: boolean; password: boolean };
  max_len: number;
  widgets: FormWidget[];
}

export interface FormModel {
  has_form: boolean;
  /** XFA fields are a partial fallback — the UI warns rather than pretending. */
  is_xfa: boolean;
  /** The field list was capped — a document claiming thousands of fields. */
  truncated: boolean;
  fields: FormField[];
}

/** What the builder sends: one entry of `edit_form_fields_batch`'s `ops`. */
export interface FormFieldSpec {
  name: string;
  type?: FormFieldType;
  page?: number;
  rect?: Rect;
  rects?: Rect[];
  options?: string[];
  default?: string | boolean | null;
  required?: boolean;
  readonly?: boolean;
  multiline?: boolean;
  max_len?: number;
  font_size?: number;
  align?: 'left' | 'center' | 'right';
}

export interface FormFieldOp {
  action: 'add' | 'update' | 'delete';
  field: FormFieldSpec;
}

/** A value as it travels to `fill_form`. */
export type FormValue = string | boolean;

// --------------------------------------------------------------------------- //
// Phase 6 — OCR, conversion, compare
// --------------------------------------------------------------------------- //
export interface OcrOptions {
  languages: string[];
  deskew?: boolean;
  rotate_pages?: boolean;
  clean?: boolean;
  /** Re-OCR pages that already have text — off by default, deliberately. */
  force?: boolean;
}

export type ExportFormat = 'docx' | 'images' | 'txt' | 'md' | 'html' | 'pdfa';

/** What a `convert_to` job leaves behind: an artefact, not a new version. */
export interface JobExport {
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_key: string;
}

/** A file parked by `POST /api/uploads/source/`, awaiting conversion. */
export interface SourceAsset {
  ref: string;
  filename: string;
  size_bytes: number;
  kind: 'pdf' | 'image' | 'html' | 'office';
}

export interface TextChange {
  kind: 'insert' | 'delete' | 'replace';
  a_text: string;
  b_text: string;
  a_rect: Rect | null;
  b_rect: Rect | null;
}

export interface ComparePage {
  a_page: number | null;
  b_page: number | null;
  text_changes: TextChange[];
  visual_regions: Rect[];
  visual_share: number;
}

export interface CompareReport {
  pages: ComparePage[];
  summary: {
    a_pages: number;
    b_pages: number;
    offset: number;
    changed_pages: number;
    text_changes: number;
    identical: boolean;
  };
}

// --------------------------------------------------------------------------- //
// Phase 7 — security & redaction
// --------------------------------------------------------------------------- //
export interface PdfPermissions {
  print: 'none' | 'lowres' | 'full';
  copy: boolean;
  modify: 'none' | 'form_fill' | 'annotate' | 'full';
  /** Always true. A PDF a screen reader cannot open excludes its user for no
   *  security gain, so the engine ignores a request to restrict it. */
  accessibility?: boolean;
}

export type RedactPresetKind = 'ssn' | 'email' | 'phone' | 'credit_card' | 'iban';

export interface RedactPattern {
  kind: 'preset' | 'regex';
  value: string;
}

export interface RedactMatch {
  id: string;
  page: number;
  rect: Rect;
  text: string;
}

export interface RedactReport {
  count: number;
  matches: RedactMatch[];
  dry_run: boolean;
}

export interface SanitizeReport {
  metadata: number;
  xmp: number;
  javascript: number;
  embedded_files: number;
  hidden_layers_flatten: number;
  links_external: number;
  comments: number;
  total: number;
}

export type StampPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface PageRange {
  pages?: number[];
  skip_first?: boolean;
}

// --------------------------------------------------------------------------- //
// Phase 8 — e-signatures
// --------------------------------------------------------------------------- //
export type SignatureKind = 'signature' | 'initials';
export type SignatureMethod = 'draw' | 'type' | 'upload';

export interface SavedSignature {
  id: string;
  kind: SignatureKind;
  method: SignatureMethod;
  typed_text: string;
  font: string;
  is_default: boolean;
  created_at: string;
}

export type RecipientRole = 'signer' | 'approver' | 'viewer' | 'cc';
export type RecipientStatus =
  | 'pending' | 'notified' | 'viewed' | 'consented' | 'completed' | 'declined';

export interface SignRecipient {
  id: string;
  email: string;
  name: string;
  role: RecipientRole;
  order: number;
  status: RecipientStatus;
  completed_at: string | null;
  last_notified_at: string | null;
  decline_reason: string;
}

export type SignFieldType =
  | 'signature' | 'initials' | 'date_signed' | 'text' | 'checkbox';

export interface SignFieldModel {
  id: string;
  recipient_id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: SignFieldType;
  required: boolean;
  label: string;
  filled?: boolean;
  value?: string;
}

export type SignRequestStatus =
  | 'draft' | 'sent' | 'completed' | 'declined' | 'expired' | 'canceled';

export interface SignRequestModel {
  id: string;
  document: string;
  document_title: string;
  title: string;
  message: string;
  status: SignRequestStatus;
  envelope_code: string;
  expires_at: string | null;
  reminder_every_days: number;
  sent_at: string | null;
  completed_at: string | null;
  final_sha256: string;
  created_at: string;
  recipients: SignRecipient[];
  fields_: SignFieldModel[];
  page_count: number;
}

/** What a recipient sees at `/s/:token` — never another recipient's fields. */
export interface CeremonyMeta {
  title: string;
  message: string;
  envelope_code: string;
  status: SignRequestStatus;
  expires_at: string | null;
  sender: { name: string; email: string };
  me: {
    name: string;
    email: string;
    role: RecipientRole;
    status: RecipientStatus;
    consented: boolean;
    needs_consent: boolean;
    my_turn: boolean;
  };
  page_count: number;
  fields: SignFieldModel[];
  disclosure_version: string;
}

export interface AuditEventModel {
  id: string;
  type: string;
  created_at: string;
  ip: string | null;
  user_agent: string;
  metadata: Record<string, unknown>;
  recipient_email: string;
  event_hash: string;
}

export interface SignatureReport {
  field: string;
  signer: string;
  intact: boolean;
  valid: boolean;
  coverage: string;
  whole_document: boolean;
  signing_time: string | null;
  timestamp: boolean;
  trusted: boolean;
  reason: string;
  error?: string;
}

export interface VerifyReport {
  sealed: boolean;
  integrity: 'intact' | 'modified' | 'unsigned';
  signatures: SignatureReport[];
  envelope_match: {
    found_code: string | null;
    known: boolean;
    sha256_match: boolean;
    completed_at?: string;
    signers?: { name: string; email: string; role: string;
                completed_at: string | null }[];
  };
}
