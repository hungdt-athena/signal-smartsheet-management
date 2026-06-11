import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL!

// Singleton to avoid creating new connections on every hot reload
const globalForDb = globalThis as unknown as { sql: ReturnType<typeof postgres> }

export const sql = globalForDb.sql ?? postgres(connectionString, {
  ssl: 'require',
  connect_timeout: 30,
  idle_timeout: 20,
  max_lifetime: 60 * 5,
})

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql
