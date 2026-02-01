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

const toUTC = (d?: Date): string =>
  new Date(d ?? 0).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

const baseName = (key: string): string =>
  key.includes('/') ? key.split('/').pop() || key : key

/* ---------- QA Sprint Overrides ----------
  Example:
  QA_SPRINT_OVERRIDES=8:8A,9:8B
------------------------------------------ */

const loadQaSprintOverrides = (): Map<number, string> => {
  const raw = process.env.QA_SPRINT_OVERRIDES
  const map = new Map<number, string>()
  if (!raw) {
    return map
  }

  raw.split(',').forEach((entry) => {
    const [num, label] = entry.split(':')
    const idx = Number(num)
    if (!Number.isNaN(idx) && label) {
      map.set(idx, label)
    }
  })

  return map
}

export const handler = async () => {
  if (!BUCKET) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>BUCKET_NAME not set</h1></body></html>',
    }
  }

  const resp = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET }))

  const versions: ObjVersion[] = resp.Versions || []

  versions.sort(
    (a, b) =>
      new Date(b.LastModified ?? 0).getTime() -
      new Date(a.LastModified ?? 0).getTime()
  )

  const latest = versions[0]
  const latestKey = latest?.Key ?? ''
  const latestVid = latest?.VersionId ?? ''

  const qaOverrides = loadQaSprintOverrides()
  const overrideKeys = [...qaOverrides.keys()]
  const firstOverride = overrideKeys.length
    ? Math.min(...overrideKeys)
    : Infinity
  const overrideCount = overrideKeys.length

  const pageTitle =
    ENVIRONMENT === Environment.QA ? 'QA Builds' : 'Download Builds'

  let html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${pageTitle}</title>
<style>
body { font-family: Arial; max-width: 900px; margin: 40px auto; padding: 20px; }
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

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const key = v.Key ?? ''
    const vid = v.VersionId ?? ''
    const name = baseName(key)
    const date = toUTC(v.LastModified)

    const isLatest = key === latestKey && vid === latestVid
    const sprintIndex = versions.length - i + 1

    let sprintLabel: string

    if (ENVIRONMENT === Environment.QA) {
      if (qaOverrides.has(sprintIndex)) {
        sprintLabel = qaOverrides.get(sprintIndex)!
      } else if (sprintIndex > firstOverride) {
        sprintLabel = String(sprintIndex - (overrideCount - 1))
      } else {
        sprintLabel = String(sprintIndex)
      }
    } else {
      sprintLabel = vid.slice(0, 10)
    }

    let commitMsg = ''
    if (ENVIRONMENT === Environment.DEV && vid) {
      try {
        const tags = await s3.send(
          new GetObjectTaggingCommand({
            Bucket: BUCKET,
            Key: key,
            VersionId: vid,
          })
        )
        commitMsg =
          tags.TagSet?.find((t) => t.Key === 'commit-message')?.Value || ''
      } catch (err) {
        console.error('Error fetching commit message:', err)
      }
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        VersionId: vid,
      }),
      { expiresIn: 7 * 24 * 60 * 60 }
    )

    html += `
<div class="version-item ${isLatest ? 'latest' : ''}">
 <div>
   <strong>${name}</strong>${isLatest ? '<span class="badge">LATEST</span>' : ''}
   <div>📅 ${date} | Sprint: ${sprintLabel}</div>
   ${commitMsg ? `<div>${commitMsg}</div>` : ''}
 </div>
 <a href="${url}"><button>⬇️ Download</button></a>
</div>
`
  }

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
