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

const toUTC = (d: Date | undefined): string =>
  new Date(d ?? 0).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

const baseName = (key: string): string =>
  key.includes('/') ? (key.split('/').pop() ?? key) : key

// NEW: Read QA sprint overrides from env var
// Example: QA_SPRINT_OVERRIDES = "8:8A,9:8B"
const getQaSprintOverrides = (): Map<number, string> => {
  const raw = process.env.QA_SPRINT_OVERRIDES
  const map = new Map<number, string>()

  if (!raw) return map

  raw.split(',').forEach(pair => {
    const [num, label] = pair.split(':')
    const n = Number(num)
    if (!isNaN(n) && label) {
      map.set(n, label)
    }
  })

  return map
}

export const handler = async () => {
  if (!BUCKET) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>Configuration Error: BUCKET_NAME not set</h1></body></html>',
    }
  }

  const resp = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: BUCKET,
    })
  )
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

  const globalLatest = versions[0]
  const latestKey = globalLatest.Key ?? ''
  const latestVid = globalLatest.VersionId ?? ''

  const pageTitle =
    ENVIRONMENT === Environment.QA ? 'QA Builds' : 'Download Builds'

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${pageTitle}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    .version-item { background: #f5f5f5; padding: 12px 14px; margin: 10px 0; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
    .latest { background: #d4edda; border: 2px solid #28a745; }
    .info { flex-grow: 1; }
    .file-name { font-weight: bold; color: #333; }
    .file-date { color: #666; font-size: 13px; margin-top: 4px; }
    .commit-info { color: #555; font-size: 12px; margin-top: 4px; font-style: italic; }
    .badge { background: #28a745; color: #fff; padding: 3px 8px; border-radius: 3px; font-size: 12px; margin-left: 8px; }
    a.button { text-decoration: none; }
    button { padding: 9px 16px; background: #007bff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    button:hover { background: #0056b3; }
  </style>
</head>
<body>
  <h1>📦 ${pageTitle}</h1>
  <p>All versions sorted by date (newest first)</p>
`

  const qaSprintOverrides = getQaSprintOverrides() // NEW

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const key = v.Key ?? ''
    const name = baseName(key)
    const vid = v.VersionId ?? ''
    const dt = toUTC(v.LastModified)

    const isGlobalLatest = key === latestKey && vid === latestVid

    let commitMsg = ''
    if (ENVIRONMENT === Environment.DEV) {
      try {
        const tagsResp = await s3.send(
          new GetObjectTaggingCommand({
            Bucket: BUCKET,
            Key: key,
            VersionId: vid,
          })
        )
        const commitTag = tagsResp.TagSet?.find(
          (t) => t.Key === 'commit-message'
        )
        commitMsg = commitTag?.Value || ''
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        console.log('GetObjectTagging failed:', errMsg)
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

    const css = isGlobalLatest ? 'version-item latest' : 'version-item'
    const badge = isGlobalLatest ? '<span class="badge">LATEST</span>' : ''

    // NEW: QA sprint override logic
    const sprintNumber = versions.length - i + 1
    let sprintLabel = sprintNumber.toString()

    if (ENVIRONMENT === Environment.QA) {
      if (qaSprintOverrides.has(sprintNumber)) {
        sprintLabel = qaSprintOverrides.get(sprintNumber)!
      } else if (qaSprintOverrides.size > 0) {
        const maxOverride = Math.max(...qaSprintOverrides.keys())
        if (sprintNumber > maxOverride) {
          sprintLabel = (sprintNumber - qaSprintOverrides.size).toString()
        }
      }
    }

    const versionLabel =
      ENVIRONMENT === Environment.QA
        ? `Sprint: ${sprintLabel}`
        : `Version: ${vid.slice(0, 10)}...`

    html += `
    <div class="${css}">
      <div class="info">
        <div class="file-name">${name}${badge}</div>
        <div class="file-date">📅 ${dt} | ${versionLabel}</div>
        ${commitMsg ? `<div class="commit-info">💬 ${commitMsg}</div>` : ''}
      </div>
      <a class="button" href="${url}">
        <button>⬇️ Download</button>
      </a>
    </div>
`
  }

  html += `
  <p style="color: gray; margin-top: 30px; text-align: center;">
    All download links are valid for 7 days
  </p>
</body>
</html>
`

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  }
}