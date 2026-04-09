import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { formatDistanceToNow } from "date-fns"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  ApiError,
  getApiUrl,
  getJobErrors,
  getJobStatus,
  getOngoingJobs,
  type JobErrorsResponse,
  type JobKind,
  type JobStatus,
  type JobStatusValue,
  type OngoingJob,
} from "@/api"
import {
  loadIndex,
  removeJob,
  upsertJob,
  type JobIndex,
  type TrackedJob,
} from "@/jobIndex"

const POLL_INTERVAL_MS = 10_000

type StatusValueWithExpired = JobStatusValue | "expired"

interface RowState {
  status?: JobStatus
  statusValue?: StatusValueWithExpired
  errorsCount?: number
  errorsLoaded?: boolean
  errorsLoading?: boolean
  errors?: JobErrorsResponse
  fetchError?: string
}

function isTerminal(status: StatusValueWithExpired | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  )
}

function statusBadgeClass(status: StatusValueWithExpired | undefined): string {
  switch (status) {
    case "scraping":
      return "bg-amber-100 text-amber-900 ring-1 ring-amber-200"
    case "completed":
      return "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-200"
    case "failed":
      return "bg-red-100 text-red-900 ring-1 ring-red-200"
    case "cancelled":
      return "bg-zinc-200 text-zinc-700 ring-1 ring-zinc-300"
    case "expired":
      return "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200"
    default:
      return "bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200"
  }
}

function kindBadgeClass(kind: JobKind): string {
  return kind === "crawl"
    ? "bg-blue-100 text-blue-900 ring-1 ring-blue-200"
    : "bg-violet-100 text-violet-900 ring-1 ring-violet-200"
}

function formatRelative(ts: number | string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return "—"
  return formatDistanceToNow(date, { addSuffix: true })
}

function formatProgress(
  status: JobStatus | undefined,
  statusValue: StatusValueWithExpired | undefined,
): string {
  if (statusValue === "expired") return "—"
  if (!status) return "…"
  return `${status.completed} / ${status.total}`
}

function rowDisplayLabel(job: TrackedJob): string {
  return job.url ?? job.id
}

function discoveryErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.status}: ${err.message || "Failed to fetch ongoing jobs"}`
  }
  if (err instanceof Error) return err.message
  return "Failed to fetch ongoing jobs"
}

export default function App() {
  const [index, setIndex] = useState<JobIndex>(() => loadIndex())
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [lastTick, setLastTick] = useState<number>(() => Date.now())

  const patchRow = useCallback((id: string, patch: Partial<RowState>) => {
    setRows(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }, [])

  // The polling tick reads the latest `index` and `rows` via closure. We
  // refresh tickRef on every render so setInterval can call the latest
  // version without restarting the timer (which would reset the cadence).
  const tickRef = useRef<() => Promise<void>>(() => Promise.resolve())

  tickRef.current = async () => {
    let discovered: OngoingJob[] = []
    try {
      const resp = await getOngoingJobs()
      discovered = resp.jobs
      setDiscoveryError(null)
    } catch (err) {
      setDiscoveryError(discoveryErrorMessage(err))
    }

    const mergedIndex = discovered.reduce(
      (acc, job) => upsertJob(acc, job.id, job.kind, job.url),
      index,
    )
    if (mergedIndex !== index) setIndex(mergedIndex)

    const targets = Object.values(mergedIndex).filter(
      job => !isTerminal(rows[job.id]?.statusValue),
    )

    type FetchResult =
      | { kind: "ok"; job: TrackedJob; status: JobStatus }
      | { kind: "expired"; job: TrackedJob }
      | { kind: "error"; job: TrackedJob; message: string }

    const results = await Promise.all<FetchResult>(
      targets.map(async job => {
        try {
          const status = await getJobStatus(job.kind, job.id)
          return { kind: "ok", job, status }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            return { kind: "expired", job }
          }
          return {
            kind: "error",
            job,
            message: err instanceof Error ? err.message : "Status fetch failed",
          }
        }
      }),
    )

    // Single batched update — avoids O(N²) record rebuilds for N jobs.
    const newlyTerminal: TrackedJob[] = []
    setRows(prev => {
      const next = { ...prev }
      for (const r of results) {
        const existing = next[r.job.id]
        if (r.kind === "ok") {
          next[r.job.id] = {
            ...existing,
            status: r.status,
            statusValue: r.status.status,
            fetchError: undefined,
          }
          if (
            isTerminal(r.status.status) &&
            existing?.errorsCount === undefined
          ) {
            newlyTerminal.push(r.job)
          }
        } else if (r.kind === "expired") {
          next[r.job.id] = {
            ...existing,
            statusValue: "expired",
            fetchError: undefined,
          }
        } else {
          next[r.job.id] = { ...existing, fetchError: r.message }
        }
      }
      return next
    })

    // Refresh the errors count once for jobs that just hit a terminal state,
    // so the column shows a final number without waiting for a row expand.
    for (const job of newlyTerminal) {
      getJobErrors(job.kind, job.id)
        .then(errs =>
          patchRow(job.id, {
            errorsCount: errs.errors.length + errs.robotsBlocked.length,
          }),
        )
        .catch(() => {
          // non-fatal — leave the existing count alone
        })
    }

    setLastTick(Date.now())
  }

  // Polling: pause while the tab is hidden so background tabs don't hammer
  // the API, and fire one immediate refresh on becoming visible again.
  useEffect(() => {
    const fire = () => void tickRef.current()
    let handle: number | null = null
    const start = () => {
      if (handle === null) handle = window.setInterval(fire, POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (handle !== null) {
        window.clearInterval(handle)
        handle = null
      }
    }
    if (document.visibilityState === "visible") {
      fire()
      start()
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fire()
        start()
      } else {
        stop()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      stop()
    }
  }, [])

  const sortedJobs = useMemo(() => {
    const list = Object.values(index)
    list.sort((a, b) => b.firstSeenAt - a.firstSeenAt)
    return list
  }, [index])

  const summary = useMemo(() => {
    let active = 0
    let history = 0
    for (const job of sortedJobs) {
      const status = rows[job.id]?.statusValue
      if (status === undefined || status === "scraping") {
        active++
      } else {
        history++
      }
    }
    return { active, history, total: sortedJobs.length }
  }, [sortedJobs, rows])

  const handleExpand = useCallback(
    async (job: TrackedJob) => {
      let willOpen = false
      let alreadyLoaded = false
      setExpanded(prev => {
        willOpen = !prev[job.id]
        return { ...prev, [job.id]: willOpen }
      })
      if (!willOpen) return
      setRows(prev => {
        const row = prev[job.id]
        if (row?.errorsLoaded || row?.errorsLoading) {
          alreadyLoaded = true
          return prev
        }
        return { ...prev, [job.id]: { ...row, errorsLoading: true } }
      })
      if (alreadyLoaded) return
      try {
        const errs = await getJobErrors(job.kind, job.id)
        patchRow(job.id, {
          errors: errs,
          errorsCount: errs.errors.length + errs.robotsBlocked.length,
          errorsLoaded: true,
          errorsLoading: false,
        })
      } catch (err) {
        patchRow(job.id, {
          errorsLoading: false,
          fetchError:
            err instanceof Error ? err.message : "Errors fetch failed",
        })
      }
    },
    [patchRow],
  )

  const handleRemove = useCallback((job: TrackedJob) => {
    setIndex(prev => removeJob(prev, job.id))
    setRows(prev => {
      const copy = { ...prev }
      delete copy[job.id]
      return copy
    })
    setExpanded(prev => {
      const copy = { ...prev }
      delete copy[job.id]
      return copy
    })
  }, [])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Firecrawl Monitoring</h1>
            <p className="text-xs text-muted-foreground mt-1">
              {getApiUrl()} · refreshed {formatRelative(lastTick)}
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground space-y-0.5">
            <div>
              <span className="font-medium text-foreground">
                {summary.active}
              </span>{" "}
              active
            </div>
            <div>
              <span className="font-medium text-foreground">
                {summary.history}
              </span>{" "}
              in history
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {discoveryError && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            <span className="font-medium">Discovery failed:</span>{" "}
            {discoveryError}
          </div>
        )}

        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium w-[110px]">Kind</th>
                <th className="px-4 py-2 font-medium">URL / ID</th>
                <th className="px-4 py-2 font-medium w-[120px]">Status</th>
                <th className="px-4 py-2 font-medium w-[120px]">Progress</th>
                <th className="px-4 py-2 font-medium w-[90px]">Errors</th>
                <th className="px-4 py-2 font-medium w-[140px]">Started</th>
                <th className="px-4 py-2 font-medium w-[40px]"></th>
              </tr>
            </thead>
            <tbody>
              {sortedJobs.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-sm text-muted-foreground"
                  >
                    No jobs yet. Start a crawl or batch scrape and it will
                    appear here within {POLL_INTERVAL_MS / 1000}s.
                  </td>
                </tr>
              )}
              {sortedJobs.map(job => {
                const row = rows[job.id]
                const isOpen = !!expanded[job.id]
                return (
                  <RowGroup
                    key={job.id}
                    job={job}
                    row={row}
                    isOpen={isOpen}
                    onToggle={() => void handleExpand(job)}
                    onRemove={() => handleRemove(job)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          History is kept in your browser for 24h. Older entries are pruned
          automatically. Removing a row only removes it from this view — it
          does not cancel the job.
        </p>
      </main>
    </div>
  )
}

interface RowGroupProps {
  job: TrackedJob
  row: RowState | undefined
  isOpen: boolean
  onToggle: () => void
  onRemove: () => void
}

function RowGroup({ job, row, isOpen, onToggle, onRemove }: RowGroupProps) {
  const statusValue = row?.statusValue
  return (
    <>
      <tr
        className={cn(
          "border-b last:border-b-0 cursor-pointer hover:bg-muted/40 transition-colors",
          isOpen && "bg-muted/30",
        )}
        onClick={onToggle}
      >
        <td className="px-4 py-3 align-top">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
              kindBadgeClass(job.kind),
            )}
          >
            {job.kind}
          </span>
        </td>
        <td className="px-4 py-3 align-top">
          <div className="font-medium text-foreground break-all">
            {rowDisplayLabel(job)}
          </div>
          {job.url && (
            <div className="text-xs text-muted-foreground mt-0.5 font-mono break-all">
              {job.id}
            </div>
          )}
        </td>
        <td className="px-4 py-3 align-top">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
              statusBadgeClass(statusValue),
            )}
          >
            {statusValue ?? "loading"}
          </span>
        </td>
        <td className="px-4 py-3 align-top">
          {formatProgress(row?.status, statusValue)}
        </td>
        <td className="px-4 py-3 align-top">
          {row?.errorsCount ?? "—"}
        </td>
        <td className="px-4 py-3 align-top text-muted-foreground">
          {formatRelative(job.firstSeenAt)}
        </td>
        <td className="px-4 py-3 align-top text-muted-foreground">
          {isOpen ? "▾" : "▸"}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b last:border-b-0 bg-muted/10">
          <td colSpan={7} className="px-4 py-4">
            <RowDetail row={row} onRemove={onRemove} />
          </td>
        </tr>
      )}
    </>
  )
}

interface RowDetailProps {
  row: RowState | undefined
  onRemove: () => void
}

function RowDetail({ row, onRemove }: RowDetailProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
        <div>
          <div className="text-muted-foreground uppercase tracking-wide">
            Status
          </div>
          <div className="font-medium">{row?.statusValue ?? "loading"}</div>
        </div>
        <div>
          <div className="text-muted-foreground uppercase tracking-wide">
            Completed
          </div>
          <div className="font-medium">{row?.status?.completed ?? "—"}</div>
        </div>
        <div>
          <div className="text-muted-foreground uppercase tracking-wide">
            Total
          </div>
          <div className="font-medium">{row?.status?.total ?? "—"}</div>
        </div>
        <div>
          <div className="text-muted-foreground uppercase tracking-wide">
            Credits used
          </div>
          <div className="font-medium">
            {row?.status?.creditsUsed ?? "—"}
          </div>
        </div>
      </div>

      {row?.status?.warning && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {row.status.warning}
        </div>
      )}

      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          Errors
        </div>
        {row?.errorsLoading && (
          <div className="text-xs text-muted-foreground">Loading…</div>
        )}
        {!row?.errorsLoading && row?.errors && (
          <div className="space-y-2">
            {row.errors.errors.length === 0 &&
              row.errors.robotsBlocked.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No errors reported.
                </div>
              )}
            {row.errors.errors.length > 0 && (
              <div className="rounded-md border bg-background overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="border-b text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">URL</th>
                      <th className="px-3 py-1.5 font-medium w-[180px]">
                        Code
                      </th>
                      <th className="px-3 py-1.5 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.errors.errors.map(e => (
                      <tr key={e.id} className="border-b last:border-b-0">
                        <td className="px-3 py-1.5 break-all font-mono text-xs">
                          {e.url ?? "—"}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs">
                          {e.code ?? "—"}
                        </td>
                        <td className="px-3 py-1.5 break-words">
                          {e.error}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {row.errors.robotsBlocked.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Robots-blocked URLs ({row.errors.robotsBlocked.length})
                </div>
                <div className="rounded-md border bg-background p-2 text-xs font-mono space-y-0.5 max-h-40 overflow-auto">
                  {row.errors.robotsBlocked.map(url => (
                    <div key={url} className="break-all">
                      {url}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {row?.fetchError && (
          <div className="text-xs text-red-700">{row.fetchError}</div>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={e => {
            e.stopPropagation()
            onRemove()
          }}
        >
          Remove from history
        </Button>
      </div>
    </div>
  )
}
