# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Context

This directory is a new module inside the **athena-n8n-signal-auto** monorepo — a collection of automation services for the Athena/Sunflower project built around n8n cloud workflows.

**Sibling services in the repo:**

| Directory | Stack | Purpose |
|-----------|-------|---------|
| `signal-scheduler/` | Node.js 20, Express, Supabase | Webhook scheduling engine with Web UI |
| `replit-audio-chunker/` | Python 3.11, Flask, FFmpeg | Chunk audio/video files → Google Drive |
| `replit-whisper-transcribe/` | Python 3.11, FastAPI | Speech-to-text via faster-whisper |
| `gdc/`, `linkedin/`, `other/` | n8n JSON | Workflow definitions imported into n8n cloud |

## Signal Scheduler Reference (most relevant sibling)

```bash
cd ../signal-scheduler
npm install
npm start          # Express server on PORT (default 3000)
```

Key env vars: `SUPABASE_URL`, `SUPABASE_KEY`, `PORT`, `APP_URL` (keep-alive for Cloud Run).

### Architecture Pattern

The `signal-scheduler` follows a pattern likely to be reused here:
- **`index.js`** — Express server + all route handlers
- **`db.js`** — Supabase client abstraction (tables: `schedules`, `groups`, `logs`)
- **`public/`** — Vanilla JS SPA, no framework

Scheduling timezone is **hardcoded UTC+7 (Asia/Ho_Chi_Minh)**.

## Deployment

Services deploy to **Google Cloud Run** or **Replit**. Both use `PORT` env var. Cloud Run instances use a self-ping keep-alive via `APP_URL`.

## n8n Workflow Modifications

Python scripts in `gdc_vault/` and the repo root programmatically modify n8n workflow JSON files (add/remove nodes, patch JS code blocks, fix connections). When updating workflows, follow this pattern rather than editing JSON directly.
