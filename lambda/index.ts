/*
 * © 2025 Merck KGaA, Darmstadt, Germany and/or its affiliates.
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

/* ---------------- helpers ---------------- */

const toUTC = (d?: Date): string =>
  new Date(d ?? 0).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

const baseName = (key: string): string =>
  key.includes('/') ? key.split('/').pop() || key : key

/* -------- QA overrides -------- */

const loadQaSprintOverrides = (): Map<number, string> => {
  const raw = process.env.QA_SPRINT_OVERRIDES
  const map = new Map<number, string>()

  if (!raw) {
    return map
  }

  raw.split(',').forEach((e) => {
    const [num, label] = e.split(':')
    const n = Number(num)
    if (!Number.isNaN(n) && label) {
      map.set(n, label)
    }
  })

  return map
}

const resolveQaSprintLabel = (
  baseSprint: number,
  overrides: Map<number, string>
): string => {
  if (overrides.has(baseSprint)) {
    return overrides.get(baseSprint)!
  }
  return String(baseSprint)
}

/* ---------------- handler ---------------- */

export const handler = async () => {
  if (!BUCKET) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<h1>BUCKET_NAME not set</h1>',
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
  const latestKey = latest?.Key
  const latestVid = latest?.VersionId

  const qaOverrides = loadQaSprintOverrides()

  let html = `
<html>
<body>
<h1>${ENVIRONMENT === Environment.QA ? 'QA Builds' : 'Builds'}</h1>
`

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const key = v.Key ?? ''
    const vid = v.VersionId ?? ''
    const name = baseName(key)
    const date = toUTC(v.LastModified)

    const isLatest = key === latestKey && vid === latestVid

    // ✅ IMPORTANT: sprint numbering starts from 2
    const baseSprint = versions.length - i + 1

    const sprintLabel =
      ENVIRONMENT === Environment.QA
        ? resolveQaSprintLabel(baseSprint, qaOverrides)
        : vid.slice(0, 10)

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        VersionId: vid,
      }),
      { expiresIn: 604800 }
    )

    html += `
<div>
 <b>${name}${isLatest ? ' (LATEST)' : ''}</b><br/>
 ${date} | Sprint: ${sprintLabel}<br/>
 <a href="${url}">Download</a>
</div><br/>
`
  }

  html += '</body></html>'

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  }
}
