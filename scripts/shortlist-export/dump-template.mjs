// Write __tests__/fixtures/master-template.json from the live Master Template.
// Run: node --env-file=.env.local scripts/shortlist-export/dump-template.mjs
import { writeFileSync } from 'node:fs'
import { google } from 'googleapis'

const TEMPLATE_ID = '1hY8RWjEnjrAmZ7WEJgZLqq-vj9CZYPatNwFXhhtrAWo'
const raw = process.env.GOOGLE_SA_KEY_JSON
if (!raw) { console.error('GOOGLE_SA_KEY_JSON is not set'); process.exit(1) }
const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: ['https://www.googleapis.com/auth/presentations.readonly'] })
const slides = google.slides({ version: 'v1', auth })
const { data } = await slides.presentations.get({ presentationId: TEMPLATE_ID })
writeFileSync('__tests__/fixtures/master-template.json', JSON.stringify({ presentationId: 'fixture', title: data.title, pageSize: data.pageSize, slides: data.slides }, null, 1))
console.log('wrote', data.slides?.length, 'slides')
