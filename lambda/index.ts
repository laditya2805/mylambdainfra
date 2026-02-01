/*
 * © 2025 Merck KGaA, Darmstadt, Germany and/or its affiliates. All rights reserved.
 */

import {
  S3Client,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
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

const toUTC = (d?: Date): string =>
  new Date(d ?? 0).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

const baseName = (key: string): string =>
  key.includes('/') ? key.split('/').pop() || key : key

/* -------- QA sprint override helpers ------------ */

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
  // Return override label if exists
  if (overrides.has(sprintIndex)) {
    return overrides.get(sprintIndex)!
  }
  
  // Count how many overridden sprints come BEFORE this sprint
  let overriddenBefore = 0;
  for (const [overrideSprint] of overrides) {
    if (overrideSprint < sprintIndex) {
      overriddenBefore++;
    }
  }
  
  // Apply compression to numbering after overrides
  if (overriddenBefore > 0) {
    // Each group of consecutive overrides reduces the count by (overriddenBefore - 1)
    return String(sprintIndex - (overriddenBefore - 1));
  }
  
  return String(sprintIndex);
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

  /* -------- fetch S3 objects -------- */

  const versionResp = await s3.send(
    new ListObjectVersionsCommand({ Bucket: BUCKET })
  )
  const versionedObjects: ObjVersion[] = versionResp.Versions || []

  const objectResp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }))
  const currentObjects: ObjVersion[] =
    objectResp.Contents?.map((o) => ({
      Key: o.Key,
      LastModified: o.LastModified,
      VersionId: undefined,
    })) || []

  const versions: ObjVersion[] = [
    ...versionedObjects,
    ...currentObjects.filter(
      (o) => !versionedObjects.some((v) => v.Key === o.Key)
    ),
  ]

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
   .sprint-info { margin-top: 5px; color: #666; font-size: 14px; }
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
    
    // Sprint index calculation: newest = highest number
    // If there are 9 builds, newest = sprint 10, oldest = sprint 2
    const sprintIndex = versions.length - i + 1

    // Always resolve sprint label - never skip builds
    let sprintLabel: string
    if (ENVIRONMENT === Environment.QA) {
      sprintLabel = resolveQaSprintLabel(sprintIndex, qaSprintOverrides)
    } else {
      sprintLabel = sprintIndex.toString()
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
        /* ignore */
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
   <strong>${name}</strong>${
     isLatest ? '<span class="badge">LATEST</span>' : ''
   }
   <div class="sprint-info">
     📅 ${date} | ${
       ENVIRONMENT === Environment.QA
         ? `Sprint: ${sprintLabel}`
         : `Version: ${versionId.slice(0, 10)}`
     }
   </div>
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
