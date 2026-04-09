# Firecrawl Monitoring UI

A minimal read-only dashboard for a self-hosted Firecrawl instance. It auto-discovers active crawls and batch scrapes via `GET /v2/team/jobs/ongoing`, polls each one for status, and keeps finished jobs visible for 24h via a localStorage history index.

## Local development

```bash
cp .env.example .env.local
# edit .env.local if your API isn't on http://localhost:3002
pnpm install
pnpm dev
# open http://localhost:5173
```

The API at `VITE_FIRECRAWL_API_URL` must be reachable from your browser. CORS is wide open on Firecrawl by default. For self-hosted, leave `VITE_FIRECRAWL_API_KEY` empty — the UI sends a dummy `Bearer` token, which the self-hosted API accepts.

## Docker

The root `docker-compose.yaml` includes a `monitoring-ui` service. Bring up the whole stack:

```bash
docker compose up -d
# open http://localhost:3006
```

To override the API URL or port:

```bash
MONITORING_UI_API_URL=http://host.docker.internal:3002 \
MONITORING_UI_PORT=3007 \
docker compose up -d --build monitoring-ui
```

The API URL is baked in at build time, so changes require `--build`.

## What it shows

- One table, one row per job (crawl or batch scrape)
- Columns: kind, URL/id, status, completed/total, errors count, started
- Click a row to expand and see full status + error list (loaded on demand)
- Header counters: active vs history

## What it does NOT do

- No actions: read-only, no cancel/retry
- No single-scrape monitoring: single scrapes are synchronous, no trackable job
- No history beyond 24h: matches the API's data retention window
