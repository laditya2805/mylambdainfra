/*
 * © 2025 Merck KGaA, Darmstadt, Germany and/or its affiliates. All rights reserved.
 */

import {
  S3Client,
  ListObjectVersionsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/* -------------------- config -------------------- */

enum Environment {
  DEV = 'dev',
  QA = 'qa',
}

const s3 = new S3Client({})
const ENVIRONMENT = (process.env.ENVIRONMENT as Environment) || Environment.DEV
const BUCKET = process.env.BUCKET_NAME

type ObjVersion = {
  Key?: string
  VersionId?: string
  LastModified?: Date
}

/* -------------------- helpers -------------------- */

const toUTC = (d?: Date): string =>
  new Date(d ?? 0).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

const baseName = (key: string): string =>
  key.includes('/') ? key.split('/').pop() || key : key

/* -------- QA sprint override helpers ------------ */
/*
Example:
QA_SPRINT_OVERRIDES=8:8A,9:8B
*/

const loadQaSprintOverrides = (): Map<number, string> => {
  const raw = process.env.QA_SPRINT_OVERRIDES
  const map = new Map<number, string>()

  if (!raw) {
    return map
  }

  raw.split(',').forEach((entry) => {
    const [num, label] = entry.split(':')
    const index = Number(num)

    if (!Number.isNaN(index) && label) {
      map.set(index, label)
    }
  })

  return map
}

const resolveQaSprintLabel = (
  sprintIndex: number,
  overrides: Map<number, string>
): string => {
  // Exact override (8 → 8A, 9 → 8B)
  if (overrides.has(sprintIndex)) {
    return overrides.get(sprintIndex)!
  }

  // Shift numbering AFTER overrides
  const sortedKeys = Array.from(overrides.keys()).sort((a, b) => a - b)
  let shift = 0

  for (const k of sortedKeys) {
    if (sprintIndex > k) {
      shift++
    }
  }

  return String(sprintIndex - shift)
}

/* -------------------- handler -------------------- */

export const handler = async () => {
  if (!BUCKET) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>BUCKET_NAME not set</h1></body></html>',
    }
  }

  /* -------- fetch versions -------- */

  const resp = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET }))

  const versions: ObjVersion[] = resp.Versions || []

  if (versions.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>No files found</h1></body></html>',
    }
  }

  versions.sort(
    (a, b) =>
      new Date(b.LastModified ?? 0).getTime() -
      new Date(a.LastModified ?? 0).getTime()
  )

  const latest = versions[0]
  const latestKey = latest.Key ?? ''
  const latestVersionId = latest.VersionId ?? ''

  const qaSprintOverrides = loadQaSprintOverrides()

  const pageTitle =
    ENVIRONMENT === Environment.QA ? 'QA Builds' : 'Download Builds'

  /* -------- HTML header -------- */

  let html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${pageTitle}</title>
<style>
 body { font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; }
 .version-item { background: #f5f5f5; padding: 12px; margin: 10px 0; border-radius: 6px; display: flex; justify-content: space-between; }
 .latest { background: #d4edda; border: 2px solid #28a745; }
 .badge { background: #28a745; color: #fff; padding: 3px 8px; border-radius: 3px; font-size: 12px; margin-left: 8px; }
 button { padding: 8px 14px; background: #007bff; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
<h1>📦 ${pageTitle}</h1>
<p>All versions sorted by date (newest first)</p>
`

  /* -------- render builds -------- */

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const key = v.Key ?? ''
    const versionId = v.VersionId ?? ''
    const name = baseName(key)
    const date = toUTC(v.LastModified)

    const isLatest = key === latestKey && versionId === latestVersionId

    const sprintIndex = versions.length - i

    let labelText: string

    if (ENVIRONMENT === Environment.QA) {
      const sprintLabel = resolveQaSprintLabel(sprintIndex, qaSprintOverrides)
      labelText = `Sprint: ${sprintLabel}`
    } else {
      // ✅ DEV LOGIC — UNTOUCHED
      labelText = `Version: ${versionId.slice(0, 10)}`
    }

    let commitMsg = ''
    if (ENVIRONMENT === Environment.DEV && versionId) {
      try {
        const tags = await s3.send(
          new GetObjectTaggingCommand({
            Bucket: BUCKET,
            Key: key,
            VersionId: versionId,
          })
        )
        commitMsg =
          tags.TagSet?.find((t) => t.Key === 'commit-message')?.Value || ''
      } catch {
        // intentionally empty — original behavior
      }
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        VersionId: versionId || undefined,
      }),
      { expiresIn: 7 * 24 * 60 * 60 }
    )

    html += `
<div class="version-item ${isLatest ? 'latest' : ''}">
 <div>
   <strong>${name}</strong>${isLatest ? '<span class="badge">LATEST</span>' : ''}
   <div>📅 ${date} | ${labelText}</div>
   ${commitMsg ? `<div>${commitMsg}</div>` : ''}
 </div>
 <a href="${url}"><button>⬇️ Download</button></a>
</div>
`
  }

  /* -------- footer -------- */

  html += `
</body>
</html>
`

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  }
}
