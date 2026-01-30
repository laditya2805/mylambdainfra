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

/* ------------------------------------------------------------------
   QA Sprint Override Utilities
   ------------------------------------------------------------------ */

/**
 * Reads sprint overrides from environment variable.
 * Example:
 * QA_SPRINT_OVERRIDES = "8:8A,9:8B"
 */
const loadQaSprintOverrides = (): Map<number, string> => {
  const raw = process.env.QA_SPRINT_OVERRIDES
  const overrides = new Map<number, string>()

  if (!raw) return overrides

  raw.split(',').forEach(entry => {
    const [num, label] = entry.split(':')
    const sprintIndex = Number(num)

    if (!isNaN(sprintIndex) && label) {
      overrides.set(sprintIndex, label)
    }
  })

  return overrides
}

/**
 * Determines whether a base sprint should be hidden.
 * Example:
 * Sprint 8 must be hidden when 8A / 8B exist.
 */
const shouldHideBaseSprint = (
  sprintIndex: number,
  overrides: Map<number, string>
): boolean => {
  return overrides.has(sprintIndex)
}

/**
 * Resolves the final sprint label for QA environment.
 */
const resolveQaSprintLabel = (
  sprintIndex: number,
  overrides: Map<number, string>
): string | null => {
  // If sprint is explicitly overridden (8 → 8A, 9 → 8B)
  if (overrides.has(sprintIndex)) {
    return overrides.get(sprintIndex)!
  }

  // If sprint is the base sprint that got split, hide it
  if (shouldHideBaseSprint(sprintIndex - 1, overrides)) {
    return null
  }

  // Shift sprint numbers after the split
  const overrideCount = overrides.size
  if (overrideCount > 0) {
    const highestOverride = Math.max(...overrides.keys())
    if (sprintIndex > highestOverride) {
      return String(sprintIndex - overrideCount)
    }
  }

  return String(sprintIndex)
}

/* ------------------------------------------------------------------
   Lambda Handler
   ------------------------------------------------------------------ */

export const handler = async () => {
  if (!BUCKET) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>Configuration Error: BUCKET_NAME not set</h1></body></html>',
    }
  }

  const resp = await s3.send(
    new ListObjectVersionsCommand({ Bucket: BUCKET })
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

  const latest = versions[0]
  const latestKey = latest.Key ?? ''
  const latestVersionId = latest.VersionId ?? ''

  const pageTitle =
    ENVIRONMENT === Environment.QA ? 'QA Builds' : 'Download Builds'

  const qaSprintOverrides = loadQaSprintOverrides()

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

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const key = v.Key ?? ''
    const versionId = v.VersionId ?? ''
    const fileName = baseName(key)
    const modifiedAt = toUTC(v.LastModified)

    const isLatest =
      key === latestKey && versionId === latestVersionId

    let commitMessage = ''
    if (ENVIRONMENT === Environment.DEV) {
      try {
        const tagResp = await s3.send(
          new GetObjectTaggingCommand({
            Bucket: BUCKET,
            Key: key,
            VersionId: versionId,
          })
        )

        commitMessage =
          tagResp.TagSet?.find(t => t.Key === 'commit-message')?.Value || ''
      } catch (err) {
        console.log('GetObjectTagging failed:', err)
      }
    }

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        VersionId: versionId,
      }),
      { expiresIn: 7 * 24 * 60 * 60 }
    )

    const sprintIndex = versions.length - i + 1
    let sprintLabel: string | null = null

    if (ENVIRONMENT === Environment.QA) {
      sprintLabel = resolveQaSprintLabel(
        sprintIndex,
        qaSprintOverrides
      )

      // Skip base sprint that got split (e.g., Sprint 8)
      if (!sprintLabel) {
        continue
      }
    }

    const versionLabel =
      ENVIRONMENT === Environment.QA
        ? `Sprint: ${sprintLabel}`
        : `Version: ${versionId.slice(0, 10)}...`

    const cssClass = isLatest ? 'version-item latest' : 'version-item'
    const latestBadge = isLatest ? '<span class="badge">LATEST</span>' : ''

    html += `
    <div class="${cssClass}">
      <div class="info">
        <div class="file-name">${fileName}${latestBadge}</div>
        <div class="file-date">📅 ${modifiedAt} | ${versionLabel}</div>
        ${commitMessage ? `<div class="commit-info">💬 ${commitMessage}</div>` : ''}
      </div>
      <a class="button" href="${downloadUrl}">
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