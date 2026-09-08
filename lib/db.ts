import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL!

// Prepared statements stay ON, including against Neon's pooled endpoint.
//
// This used to be `prepare: !isPooled`, on the reading that PgBouncer in transaction
// pooling mode cannot carry prepared statements and would hand back `prepared statement
// "s1" already exists` under concurrency. That is true of a bare PgBouncer; it is no
// longer true of Neon's pooler, which tracks prepared statements per client connection
// at the protocol level.
//
// The workaround was not free, and on this deployment it was the single most expensive
// line in the app. Without prepare, postgres.js sends Parse/Describe and waits before it
// sends Bind/Execute, so EVERY parameterised query costs two network round-trips instead
// of one -- and the app server sits in Asia while the database sits in AWS us-east-2, so
// a round-trip is ~225ms. Nearly every query in this codebase is parameterised.
//
// Measured against this exact database (2026-09-08), 200 concurrent parameterised
// queries over a max:10 pool:
//
//   prepare: true   ->  1,694ms, 0 errors   (400 queries total across two waves)
//   prepare: false  -> 13,117ms             (7.7x slower)
//
// A single query, warm connection: 252ms prepared vs 490ms unprepared -- exactly the
// extra round-trip. If Neon's pooler ever loses this support the symptom is loud and
// specific (`prepared statement "sN" already exists`), so it fails visibly rather than
// silently going slow the way the old setting did.
//
// The pooler itself matters because this app deploys to Cloud Run (see .replit):
// several instances x max 10 connections each is a lot of real backends on a small Neon
// compute, and every cold start otherwise pays a fresh TLS handshake.

// Singleton to avoid creating new connections on every hot reload
const globalForDb = globalThis as unknown as { sql: ReturnType<typeof postgres> }

export const sql = globalForDb.sql ?? postgres(connectionString, {
  ssl: 'require',
  connect_timeout: 30,
  idle_timeout: 20,
  max_lifetime: 60 * 5,
  prepare: true,
})

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql
