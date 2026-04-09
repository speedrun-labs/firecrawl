// localStorage-backed history index for monitored jobs.
//
// Why this exists: the Firecrawl self-hosted API has no endpoint that lists
// finished crawls or batch scrapes. The only way to keep a job visible after
// it falls off /v2/team/jobs/ongoing is for the UI to remember the id itself.
// Each time we observe a new id (from the ongoing endpoint), we upsert it
// here. The status endpoint /v2/{kind}/:id continues to return data for ~24h
// after completion, so we can still render terminal status / errors for
// finished jobs.
//
// Entries older than 24h are pruned on load (matches the API-side TTL).

import type { JobKind } from "./api"

const STORAGE_KEY = "firecrawl.monitoring.jobs"
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface TrackedJob {
  id: string
  kind: JobKind
  url: string | null
  firstSeenAt: number
}

export type JobIndex = Record<string, TrackedJob>

function readRaw(): JobIndex {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    return parsed as JobIndex
  } catch {
    return {}
  }
}

function writeRaw(index: JobIndex): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(index))
  } catch {
    // localStorage may be unavailable (private mode, etc.) — degrade silently
  }
}

export function loadIndex(): JobIndex {
  const index = readRaw()
  const cutoff = Date.now() - MAX_AGE_MS
  let changed = false
  for (const id of Object.keys(index)) {
    if (index[id].firstSeenAt < cutoff) {
      delete index[id]
      changed = true
    }
  }
  if (changed) writeRaw(index)
  return index
}

export function upsertJob(
  index: JobIndex,
  id: string,
  kind: JobKind,
  url: string | null,
): JobIndex {
  if (index[id]) {
    // Refresh url if we just learned it; keep the original firstSeenAt.
    if (url && !index[id].url) {
      index = { ...index, [id]: { ...index[id], url } }
      writeRaw(index)
    }
    return index
  }
  const next: JobIndex = {
    ...index,
    [id]: { id, kind, url, firstSeenAt: Date.now() },
  }
  writeRaw(next)
  return next
}

export function removeJob(index: JobIndex, id: string): JobIndex {
  if (!index[id]) return index
  const next = { ...index }
  delete next[id]
  writeRaw(next)
  return next
}
