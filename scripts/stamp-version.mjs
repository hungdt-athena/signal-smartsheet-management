// Stamps version.json with a fresh build id, run right before `next build`
// (see package.json). The id is baked into BOTH the client bundle and the server
// bundle of the same build, so within one deploy they match; after a republish a
// still-open browser holds the OLD id and detects the mismatch → offers a reload.
//
// Prefers the git short SHA, but always appends a timestamp so rebuilding the same
// commit still bumps the id. The value only ever changes on a rebuild — so a plain
// container restart (no new code) does NOT trigger a false "update available".
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

let sha = ''
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
} catch {
  // Not a git checkout (or git unavailable) — timestamp alone is enough.
}

const buildId = `${sha ? sha + '-' : ''}${Date.now()}`
const target = new URL('../version.json', import.meta.url)
writeFileSync(target, JSON.stringify({ buildId }, null, 2) + '\n')
console.log(`[stamp-version] buildId = ${buildId}`)
