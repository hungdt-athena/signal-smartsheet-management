import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL!

// Neon's pooled endpoint (host contains `-pooler`) fronts Postgres with PgBouncer in
// transaction pooling mode, which does NOT support prepared statements: leaving
// postgres.js's default `prepare: true` on gets you `prepared statement "s1" already
// exists` under concurrency. Detected from the host rather than hardcoded so the same
// code works against a direct endpoint in local dev and the pooler in deployment.
//
// The pooler matters because this app deploys to Cloud Run (see .replit): several
// instances x max 10 connections each is a lot of real backends on a small Neon
// compute, and every cold start otherwise pays a fresh TLS handshake.
const isPooled = /-pooler\./.test(connectionString)

// Singleton to avoid creating new connections on every hot reload
const globalForDb = globalThis as unknown as { sql: ReturnType<typeof postgres> }

export const sql = globalForDb.sql ?? postgres(connectionString, {
  ssl: 'require',
  connect_timeout: 30,
  idle_timeout: 20,
  max_lifetime: 60 * 5,
  prepare: !isPooled,
})

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql
