// package.json deps:
//   "@aws-sdk/client-s3": "^3.x"
//   "@aws-sdk/s3-request-presigner": "^3.x"

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});
const BUCKET = "dev-aditya-280595";  // TODO: set QA bucket
const PREFIX = "";                      // e.g., "qa-builds/"
const EXPIRES_SECONDS = 7 * 24 * 60 * 60;

// Oldest visible item will be labeled as this sprint number.
// Example: if you currently keep sprints 2..5, set sprintStart=2.
const sprintStart = 2;

export const handler = async (event, context) => {
  // Collect all objects (handle pagination)
  const objects = [];
  let ContinuationToken;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: PREFIX,
        ContinuationToken
      })
    );
    if (resp.Contents) objects.push(...resp.Contents);
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);

  // Filter out "folders" (zero-size prefixes) if needed
  const files = objects.filter(o => o.Key && (!o.Key.endsWith("/") || (o.Size ?? 0) > 0));

  if (files.length === 0) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<html><body><h1>No builds found</h1></body></html>"
    };
  }

  // Sort newest first
  files.sort((a, b) => new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime());

  // Map to sprint labels: oldest gets sprintStart, then increment
  const oldestFirst = [...files].reverse();
  const labelsByKey = new Map();
  oldestFirst.forEach((obj, idx) => {
    labelsByKey.set(obj.Key, `Sprint: ${sprintStart + idx}`);
  });

  // Single global latest (newest)
  const newest = files[0];
  const newestKey = newest.Key;

  // Build HTML
  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>QA Builds</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    .version-item { background: #f5f5f5; padding: 12px 14px; margin: 10px 0; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
    .latest { background: #d4edda; border: 2px solid #28a745; }
    .info { flex-grow: 1; }
    .file-name { font-weight: bold; color: #333; }
    .file-date { color: #666; font-size: 13px; margin-top: 4px; }
    .badge { background: #28a745; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px; margin-left: 8px; }
    a.button { text-decoration: none; }
    button { padding: 9px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    button:hover { background: #0056b3; }
  </style>
</head>
<body>
  <h1>📦 QA Builds</h1>
  <p>Newest first. Labels reflect sprint order.</p>
`;

  for (const obj of files) {
    const key = obj.Key;
    const dt = new Date(obj.LastModified).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const isLatest = key === newestKey;

    // Presign
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: EXPIRES_SECONDS }
    );

    const css = isLatest ? "version-item latest" : "version-item";
    const badge = isLatest ? `<span class="badge">LATEST</span>` : "";
    const sprintLabel = labelsByKey.get(key) ?? "";

    html += `
    <div class="${css}">
      <div class="info">
        <div class="file-name">${key.split("/").pop()} ${badge}</div>
        <div class="file-date">📅 ${dt} | ${sprintLabel}</div>
      </div>
      <a class="button" href="${url}">
        <button>⬇️ Download</button>
      </a>
    </div>
`;
  }

  html += `
  <p style="color: gray; margin-top: 30px; text-align: center;">
    All download links are valid for 7 days
  </p>
</body>
</html>
`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html
  };
};
