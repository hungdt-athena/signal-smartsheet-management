// Service-account Google client for the Short List export (Slides, Sheets, Drive).
//
// The rest of the app talks to Google through an OAuth refresh token (lib/google-sheets.ts).
// The export uses the PJ202 service account instead, so files it creates belong to the
// Shared Drive folder and not to a person. The key is the whole JSON file in one env var.

import { google } from 'googleapis'
import { EXPORT_TYPES, type ExportFormat, type ExportScope, type ExportType } from './types'

export const EXPORT_FOLDER_ID = '1R5nipvRfobP7V_6zM1-GBvNaAmTvGwzY'
export const MASTER_TEMPLATE_ID = '1hY8RWjEnjrAmZ7WEJgZLqq-vj9CZYPatNwFXhhtrAWo'

export type ExportAuth = InstanceType<typeof google.auth.GoogleAuth>

export function getExportAuth(): ExportAuth {
  const raw = process.env.GOOGLE_SA_KEY_JSON
  if (!raw) throw new Error('GOOGLE_SA_KEY_JSON is not set')
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  })
}

/** Move a half-built file to the trash. Never throws: the caller is already handling an error. */
export async function trashFile(auth: ExportAuth, fileId: string): Promise<void> {
  try {
    await google.drive({ version: 'v3', auth }).files.update({
      fileId, requestBody: { trashed: true }, supportsAllDrives: true,
    })
  } catch (e) {
    console.error('[shortlist-export] could not trash', fileId, e)
  }
}

// ---- Finding an earlier export ------------------------------------------------------------
// Every file the export creates carries appProperties { slExport: "<period>|<types>" }, so the
// dialog can offer "Open file" instead of building the same deck twice. Files made before the
// tag existed are matched by their exact name too. Renamed files keep the tag; trashed ones
// drop out on their own.

export const EXPORT_PROP = 'slExport'

const MIME: Record<string, string> = {
  slides: 'application/vnd.google-apps.presentation',
  sheets: 'application/vnd.google-apps.spreadsheet',
}
const OPEN_URL: Record<string, (id: string) => string> = {
  slides: id => `https://docs.google.com/presentation/d/${id}/edit`,
  sheets: id => `https://docs.google.com/spreadsheets/d/${id}/edit`,
}

/** 'W3 Oct, 2026|insight,priority_iv' or 'month:2026-10|priority_iv'. */
export function exportKey(scope: ExportScope, types: ExportType[]): string {
  const period = scope.kind === 'week' ? scope.labels[0] : `month:${scope.monthKey}`
  return `${period}|${EXPORT_TYPES.filter(t => types.includes(t)).join(',')}`
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

export async function findExport(
  auth: ExportAuth, scope: ExportScope, types: ExportType[], format: ExportFormat, name: string,
): Promise<{ url: string; createdTime: string | null } | null> {
  const mime = MIME[format]
  if (!mime) return null
  const key = exportKey(scope, types)
  const res = await google.drive({ version: 'v3', auth }).files.list({
    q: `'${EXPORT_FOLDER_ID}' in parents and mimeType = '${mime}' and trashed = false and `
      + `(appProperties has { key='${EXPORT_PROP}' and value='${q(key)}' } or name = '${q(name)}')`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
    orderBy: 'createdTime desc',
    pageSize: 1,
    fields: 'files(id, createdTime)',
  })
  const f = res.data.files?.[0]
  return f?.id ? { url: OPEN_URL[format](f.id), createdTime: f.createdTime ?? null } : null
}
