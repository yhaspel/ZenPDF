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

export interface AppConfig {
  limits: {
    max_upload_mb: number;
    user_storage_quota_mb: number;
    max_pages: number;
    version_retention: number;
    sign_requests_per_month: number;
    ocr_pages_per_month: number;
    max_concurrent_jobs: number;
  };
  features: { ads_enabled: boolean; presigned_delivery: boolean };
  ads: { client_id: string };
}

export interface Usage {
  period: string;
  storage: { used_bytes: number; quota_bytes: number };
  counters: { sign_requests: number; ocr_pages: number; conversions: number };
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
