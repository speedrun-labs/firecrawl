// Lightweight Firecrawl API client for the monitoring UI.
// All endpoints used here are read-only.

const API_URL =
  import.meta.env.VITE_FIRECRAWL_API_URL || "http://localhost:3002"

// Self-hosted Firecrawl requires the Authorization header to exist but does
// not validate its value when USE_DB_AUTHENTICATION=false. We default to
// "dummy" so the UI works out of the box against a fresh self-hosted stack.
const API_KEY = import.meta.env.VITE_FIRECRAWL_API_KEY || "dummy"

export type JobKind = "crawl" | "batch_scrape"

export type JobStatusValue =
  | "scraping"
  | "completed"
  | "failed"
  | "cancelled"

export interface OngoingJob {
  id: string
  kind: JobKind
  teamId: string
  url: string | null
  created_at: string
}

export interface OngoingJobsResponse {
  success: true
  jobs: OngoingJob[]
}

export interface JobStatus {
  success: boolean
  status: JobStatusValue
  completed: number
  total: number
  creditsUsed: number
  expiresAt?: string
  warning?: string
}

export interface JobErrorItem {
  id: string
  url?: string
  code?: string
  error: string
  timestamp?: string
}

export interface JobErrorsResponse {
  errors: JobErrorItem[]
  robotsBlocked: string[]
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = "ApiError"
  }
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  })
  if (!res.ok) {
    let body = ""
    try {
      body = await res.text()
    } catch {
      // ignore
    }
    throw new ApiError(res.status, body || res.statusText)
  }
  try {
    return (await res.json()) as T
  } catch (err) {
    throw new ApiError(
      res.status,
      `Invalid JSON in response: ${err instanceof Error ? err.message : err}`,
    )
  }
}

export function getOngoingJobs(): Promise<OngoingJobsResponse> {
  return apiFetch<OngoingJobsResponse>("/v2/team/jobs/ongoing")
}

function jobPath(kind: JobKind, id: string): string {
  return kind === "crawl" ? `/v2/crawl/${id}` : `/v2/batch/scrape/${id}`
}

export function getJobStatus(
  kind: JobKind,
  id: string,
): Promise<JobStatus> {
  return apiFetch<JobStatus>(jobPath(kind, id))
}

export function getJobErrors(
  kind: JobKind,
  id: string,
): Promise<JobErrorsResponse> {
  return apiFetch<JobErrorsResponse>(`${jobPath(kind, id)}/errors`)
}

export function getApiUrl(): string {
  return API_URL
}
