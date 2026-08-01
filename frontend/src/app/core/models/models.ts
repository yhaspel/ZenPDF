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
  ads: { client_id: string };
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

export interface ApiError {
  error: { code: string; message: string; details: Record<string, unknown> };
}
