// package.json should include:
//   "@aws-sdk/client-s3": "^3.x",
//   "@aws-sdk/s3-request-presigner": "^3.x"

import { S3Client, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});
const BUCKET = "dev-aditya-280595";   // change if needed
const PREFIX = "";                     // e.g., "folder/"

export const handler = async (event, context) => {
  // Get all versions (handle pagination)
  const versions = [];
  let KeyMarker;
  let VersionIdMarker;

  do {
    const resp = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: BUCKET,
        Prefix: PREFIX,
        KeyMarker,
        VersionIdMarker
      })
    );
    if (resp.Versions) versions.push(...resp.Versions);

    // pagination markers
    KeyMarker = resp.IsTruncated ? resp.NextKeyMarker : undefined;
    VersionIdMarker = resp.IsTruncated ? resp.NextVersionIdMarker : undefined;
  } while (KeyMarker && VersionIdMarker);

  if (versions.length === 0) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<html><body><h1>No files found</h1></body></html>"
    };
  }

  // Newest first
  versions.sort((a, b) => new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime());

  // Compute the single globally latest version across all keys
  const globalLatest = versions[0];
  const latestKey = globalLatest.Key;
  const latestVid = globalLatest.VersionId;

  // Build HTML head and styles (minimal, inline)
  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Download Builds</title>
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
  <h1>📦 Download Builds</h1>
  <p>All versions sorted by date (newest first)</p>
`;

  // Render each version row with a presigned URL
  for (const v of versions) {
    const key = v.Key;
    const vid = v.VersionId;
    const dt = new Date(v.LastModified).toISOString().replace("T", " ").slice(0, 16) + " UTC";

    // Only the single global newest version gets the LATEST badge
    const isGlobalLatest = key === latestKey && vid === latestVid;

    // Presign specific version
    const url = await getSignedUrl(
      s3,
      // GetObjectCommand supports VersionId via query param, so build URL manually with signer options
      // Simpler approach: use a dummy GetObjectCommand and pass versionId in request context
      // However, the SDK v3 signer allows query customization via the command input itself:
      // We'll use the requestEndpoint override by including VersionId in the query by setting it in input:
      new (await import("@aws-sdk/client-s3")).GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        VersionId: vid
      }),
      { expiresIn: 7 * 24 * 60 * 60 }
    );

    const css = isGlobalLatest ? "version-item latest" : "version-item";
    const badge = isGlobalLatest ? `<span class="badge">LATEST</span>` : "";
    const shortVid = vid && vid.length > 13 ? vid.slice(0, 10) + "..." : vid || "";

    html += `
    <div class="${css}">
      <div class="info">
        <div class="file-name">${key}${badge}</div>
        <div class="file-date">📅 ${dt} | Version: ${shortVid}</div>
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
