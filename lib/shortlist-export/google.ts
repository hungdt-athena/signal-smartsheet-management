// Service-account Google client for the Short List export (Slides, Sheets, Drive).
//
// The rest of the app talks to Google through an OAuth refresh token (lib/google-sheets.ts).
// The export uses the PJ202 service account instead, so files it creates belong to the
// Shared Drive folder and not to a person. The key is the whole JSON file in one env var.

import { google } from 'googleapis'

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
