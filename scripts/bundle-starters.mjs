import fs from "node:fs/promises";
import path from "node:path";
import { parseImageRef } from "../src/oci.js";

const OUT_DIR = path.resolve("public/oci");

const STARTERS = [
  "hello-world",
  "busybox",
  "alpine",
  "nginx:alpine-slim",
  "python:3.13-alpine",
];

async function bundleRemoteImage(rawRef) {
  const ref = parseImageRef(rawRef);
  const imgDir = path.join(OUT_DIR, ref.safeKey);
  const metaPath = path.join(imgDir, "meta.json");

  try {
    await fs.access(metaPath);
    console.log(`[bundle] cached: ${ref.fullName} -> public/oci/${ref.safeKey}`);
    return;
  } catch {}

  console.log(`[bundle] pulling ${ref.fullName} (linux/arm64)...`);
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${ref.repo}:pull`
  );
  if (!tokenRes.ok) throw new Error(`Auth failed for ${ref.repo}: ${tokenRes.status}`);
  const { token } = await tokenRes.json();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const base = `https://registry-1.docker.io/v2/${ref.repo}`;
  const idxRes = await fetch(`${base}/manifests/${ref.tag}`, {
    headers: {
      ...authHeaders,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  if (!idxRes.ok) throw new Error(`Manifest failed for ${ref.fullName}: ${idxRes.status}`);
  let manifest = await idxRes.json();
  let digest = idxRes.headers.get("docker-content-digest") || "";

  if (manifest.manifests) {
    const arm64 = manifest.manifests.find(
      (m) => m.platform?.os === "linux" && m.platform?.architecture === "arm64"
    );
    if (!arm64) throw new Error(`No linux/arm64 manifest for ${ref.fullName}`);
    digest = arm64.digest;
    const mRes = await fetch(`${base}/manifests/${arm64.digest}`, {
      headers: {
        ...authHeaders,
        Accept: [
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    });
    if (!mRes.ok) throw new Error(`Arm64 manifest failed: ${mRes.status}`);
    manifest = await mRes.json();
  }

  const cfgRes = await fetch(`${base}/blobs/${manifest.config.digest}`, { headers: authHeaders });
  if (!cfgRes.ok) throw new Error(`Config fetch failed: ${cfgRes.status}`);
  const config = await cfgRes.json();

  await fs.mkdir(imgDir, { recursive: true });
  const layers = [];
  for (let i = 0; i < manifest.layers.length; i++) {
    const l = manifest.layers[i];
    const lRes = await fetch(`${base}/blobs/${l.digest}`, { headers: authHeaders });
    if (!lRes.ok) throw new Error(`Layer ${i} failed: ${lRes.status}`);
    const bytes = new Uint8Array(await lRes.arrayBuffer());
    await fs.writeFile(path.join(imgDir, `layer-${i}.tar.gz`), bytes);
    layers.push({ digest: l.digest, size: bytes.byteLength, file: `layer-${i}.tar.gz` });
  }

  const meta = {
    image: ref.fullName,
    safeKey: ref.safeKey,
    digest: digest || manifest.config.digest,
    configDigest: manifest.config.digest,
    config: config.config || {},
    layers,
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  const mb = (layers.reduce((a, x) => a + x.size, 0) / 1048576).toFixed(2);
  console.log(`[bundle] wrote ${ref.fullName}: ${layers.length} layers, ${mb} MB`);
}

async function bundleLocalFbdoom() {
  const ref = parseImageRef("ghcr.io/taeold/fbdoom");
  const srcDir = path.resolve("fbdoom/oci-dist");
  const imgDir = path.join(OUT_DIR, ref.safeKey);
  await fs.mkdir(imgDir, { recursive: true });

  const meta = JSON.parse(await fs.readFile(path.join(srcDir, "meta.json"), "utf8"));
  const cfg = JSON.parse(await fs.readFile(path.join(srcDir, "config.json"), "utf8"));
  const layerBytes = await fs.readFile(path.join(srcDir, "layer-0.tar.gz"));
  await fs.writeFile(path.join(imgDir, "layer-0.tar.gz"), layerBytes);

  const staticMeta = {
    image: ref.fullName,
    safeKey: ref.safeKey,
    digest: meta.configDigest,
    configDigest: meta.configDigest,
    config: cfg.config || {},
    layers: [{ digest: meta.layerDigest, size: layerBytes.byteLength, file: "layer-0.tar.gz" }],
  };
  await fs.writeFile(path.join(imgDir, "meta.json"), JSON.stringify(staticMeta, null, 2));
  console.log(
    `[bundle] wrote ${ref.fullName}: 1 layer, ${(layerBytes.byteLength / 1048576).toFixed(2)} MB`
  );
}

await fs.mkdir(OUT_DIR, { recursive: true });
for (const img of STARTERS) {
  await bundleRemoteImage(img);
}
await bundleLocalFbdoom();
console.log("[bundle] all starter images ready in public/oci/");
