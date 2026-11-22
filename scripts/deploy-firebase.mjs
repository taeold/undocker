import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";

const PROJECT_ID = process.env.FIREBASE_PROJECT || "next-build-in-browser";
const SITE_ID = process.env.FIREBASE_SITE || "undocker";
const DIST_DIR = path.resolve("dist");

const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const apiHeaders = {
  Authorization: `Bearer ${token}`,
  "X-Goog-User-Project": PROJECT_ID,
  "Content-Type": "application/json",
};

async function apiJson(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: apiHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function walkFiles(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...(await walkFiles(full, base)));
    } else if (e.isFile()) {
      const rel = "/" + path.relative(base, full).split(path.sep).join("/");
      results.push({ rel, full });
    }
  }
  return results;
}

const firebaseJson = JSON.parse(await fs.readFile(path.resolve("firebase.json"), "utf8"));
const hostingConfig = firebaseJson.hosting || {};

console.log(`[deploy] Walking ${DIST_DIR}...`);
const fileList = await walkFiles(DIST_DIR);

// Firebase Hosting expects gzip-compressed bytes & SHA-256 of the gzipped payload
const filesMap = {};
const hashToGzip = new Map();
let totalRaw = 0;
let totalGz = 0;

for (const { rel, full } of fileList) {
  const raw = await fs.readFile(full);
  const gz = zlib.gzipSync(raw, { level: 6 });
  const hash = crypto.createHash("sha256").update(gz).digest("hex");
  filesMap[rel] = hash;
  hashToGzip.set(hash, { gz, rel });
  totalRaw += raw.length;
  totalGz += gz.length;
}

console.log(
  `[deploy] Prepared ${fileList.length} files (${(totalRaw / 1048576).toFixed(2)} MB raw -> ${(
    totalGz / 1048576
  ).toFixed(2)} MB gzipped)`
);

// 1. Create new Hosting version
const version = await apiJson(
  `https://firebasehosting.googleapis.com/v1beta1/sites/${SITE_ID}/versions`,
  {
    method: "POST",
    body: {
      config: {
        headers: (hostingConfig.headers || []).map((h) => ({
          glob: h.source,
          headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])),
        })),
      },
    },
  }
);
console.log(`[deploy] Created version: ${version.name}`);

// 2. Populate files
const pop = await apiJson(
  `https://firebasehosting.googleapis.com/v1beta1/${version.name}:populateFiles`,
  {
    method: "POST",
    body: { files: filesMap },
  }
);

const required = pop.uploadRequiredHashes || [];
console.log(`[deploy] Uploading ${required.length} file(s)...`);

function uploadOneHttp1(urlStr, gz) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      u,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Goog-User-Project": PROJECT_ID,
          "Content-Type": "application/octet-stream",
          "Content-Length": gz.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
        });
      }
    );
    req.on("error", reject);
    req.end(gz);
  });
}

// 3. Upload required hashes over HTTP/1.1 with retry (avoids HTTP/2 ENHANCE_YOUR_CALM on large blobs)
const queue = [...required];
const workers = Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, async () => {
  while (queue.length > 0) {
    const hash = queue.shift();
    const { gz, rel } = hashToGzip.get(hash);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await uploadOneHttp1(`${pop.uploadUrl}/${hash}`, gz);
        console.log(`  uploaded ${rel} (${(gz.length / 1024).toFixed(1)} kB gz)`);
        break;
      } catch (err) {
        if (attempt === 3) throw new Error(`Upload failed for ${rel}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
});
await Promise.all(workers);

// 4. Finalize version
await apiJson(
  `https://firebasehosting.googleapis.com/v1beta1/${version.name}?update_mask=status`,
  {
    method: "PATCH",
    body: { status: "FINALIZED" },
  }
);

// 5. Release live!
const release = await apiJson(
  `https://firebasehosting.googleapis.com/v1beta1/sites/${SITE_ID}/releases?versionName=${encodeURIComponent(
    version.name
  )}`,
  { method: "POST", body: {} }
);

console.log(`[deploy] Released: ${release.name}`);
console.log(`[deploy] Live at: https://${SITE_ID}.web.app`);
