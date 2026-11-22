/**
 * Browser-native OCI Registry v2 puller for linux/arm64 images.
 * - Checks static pre-bundled OCI mirror (/oci/<safeKey>/) first (works 100% static on Firebase Hosting)
 * - Falls back to live registry proxy (/api/oci/*) when available
 * - Deduplicates layers by SHA-256 digest across images (e.g. shared Alpine base layer)
 * - Downloads & gunzips layers in parallel with Web DecompressionStream
 */

const IMAGE_ALIASES = {
  doom: "ghcr.io/taeold/fbdoom:latest",
  fbdoom: "ghcr.io/taeold/fbdoom:latest",
};

export function parseImageRef(raw) {
  const trimmed = raw.trim();
  const input = IMAGE_ALIASES[trimmed] || trimmed;
  let registry = "registry-1.docker.io";
  let repo = input;
  let tag = "latest";

  const lastSlash = input.lastIndexOf("/");
  const lastColon = input.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = input.slice(lastColon + 1);
    repo = input.slice(0, lastColon);
  }

  const firstSlash = repo.indexOf("/");
  if (firstSlash !== -1) {
    const maybeHost = repo.slice(0, firstSlash);
    if (maybeHost.includes(".") || maybeHost.includes(":")) {
      registry = maybeHost;
      repo = repo.slice(firstSlash + 1);
    }
  }

  const displayRepo = repo;
  if (registry === "registry-1.docker.io" && !repo.includes("/")) {
    repo = `library/${repo}`;
  }

  const safeKey = `${registry}_${repo}_${tag}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return {
    raw: trimmed,
    registry,
    repo,
    displayRepo,
    tag,
    hasExplicitTag: lastColon > lastSlash,
    safeKey,
    fullName:
      registry === "registry-1.docker.io"
        ? `${displayRepo}:${tag}`
        : `${registry}/${displayRepo}:${tag}`,
  };
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzipIfNeeded(bytes) {
  if (!isGzip(bytes)) return bytes;
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function shellQuote(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function digestId(digest, fallbackIdx) {
  return (digest || `layer${fallbackIdx}`).replace(/^sha256:/, "").slice(0, 16);
}

async function fetchRegistryToken(ref) {
  if (ref.registry === "registry-1.docker.io") {
    const res = await fetch(
      `/api/oci/docker-auth?service=registry.docker.io&scope=repository:${encodeURIComponent(
        ref.repo
      )}:pull`
    );
    if (!res.ok) throw new Error(`auth failed (${res.status}) for ${ref.repo}`);
    const data = await res.json();
    return data.token || data.access_token;
  }
  if (ref.registry === "ghcr.io") {
    const res = await fetch(
      `/api/oci/ghcr-token?scope=repository:${encodeURIComponent(ref.repo)}:pull`
    );
    if (!res.ok) throw new Error(`ghcr auth failed (${res.status}) for ${ref.repo}`);
    const data = await res.json();
    return data.token;
  }
  return null;
}

export class OciStore {
  constructor(memFs) {
    this.memFs = memFs;
    this.images = new Map(); // safeKey -> imageRecord
    this.layerSizes = new Map(); // layerId -> uncompressedBytes
    this.memFs.mkdirp("/layers");
    this.memFs.mkdirp("/images");
  }

  get(rawRef) {
    const ref = parseImageRef(rawRef);
    return this.images.get(ref.safeKey) || null;
  }

  list() {
    return Array.from(this.images.values());
  }

  async downloadLayersParallel(layers, fetchLayerFn, { emit, signal }) {
    const layerIds = [];
    let totalCompressed = 0;
    let totalUncompressed = 0;

    await Promise.all(
      layers.map(async (layer, idx) => {
        const lid = digestId(layer.digest, idx);
        const shortId = lid.slice(0, 12);
        layerIds[idx] = lid;

        if (this.layerSizes.has(lid)) {
          totalUncompressed += this.layerSizes.get(lid);
          await emit(`${shortId}: Already exists\n`);
          return;
        }

        const expected = layer.size ? ` (${formatSize(layer.size)})` : "";
        await emit(`${shortId}: Downloading${expected}\n`);

        const compressed = await fetchLayerFn(layer, idx, signal);
        totalCompressed += compressed.byteLength;

        const tarBytes = await gunzipIfNeeded(compressed);
        totalUncompressed += tarBytes.byteLength;

        this.memFs.writeFile(`/layers/${lid}.tar`, tarBytes);
        this.layerSizes.set(lid, tarBytes.byteLength);
        await emit(`${shortId}: Pull complete\n`);
      })
    );

    return { layerIds, totalCompressed, totalUncompressed };
  }

  async finalizeImage(
    ref,
    { config, digest, configDigest, layerIds, totalCompressed, totalUncompressed, emit }
  ) {
    const dir = `/images/${ref.safeKey}`;
    this.memFs.mkdirp(dir);

    const cfg = config || {};
    const entrypoint = Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint : [];
    const cmd = Array.isArray(cfg.Cmd) ? cfg.Cmd : [];
    const env =
      Array.isArray(cfg.Env) && cfg.Env.length > 0
        ? cfg.Env
        : ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
    const workdir = cfg.WorkingDir || "/";

    this.memFs.writeFile(`${dir}/layers.list`, layerIds.join("\n") + "\n");
    this.memFs.writeFile(`${dir}/workdir`, `${workdir}\n`);
    this.memFs.writeFile(`${dir}/env.args`, env.map(shellQuote).join(" ") + "\n");
    this.memFs.writeFile(`${dir}/entrypoint.args`, entrypoint.map(shellQuote).join(" ") + "\n");
    this.memFs.writeFile(`${dir}/cmd.args`, cmd.map(shellQuote).join(" ") + "\n");

    const imageId = (configDigest || digest || ref.safeKey).replace(/^sha256:/, "").slice(0, 12);
    const record = {
      ref,
      imageId,
      digest: digest || configDigest,
      layers: layerIds.length,
      compressedBytes: totalCompressed,
      uncompressedBytes: totalUncompressed,
      sizeLabel: formatSize(totalUncompressed),
      pulledAt: Date.now(),
      config: cfg,
    };
    this.images.set(ref.safeKey, record);

    if (record.digest) {
      await emit(`Digest: ${record.digest}\n`);
    }
    await emit(`Status: Downloaded newer image for ${ref.fullName}\n`);
    return record;
  }

  async pullStaticMirror(ref, { emit, signal }) {
    const metaRes = await fetch(`/oci/${ref.safeKey}/meta.json`, { signal });
    if (!metaRes.ok) return null;
    const ct = metaRes.headers.get("content-type") || "";
    if (!ct.includes("json")) return null;

    const meta = await metaRes.json();
    const layers = meta.layers || [];

    const { layerIds, totalCompressed, totalUncompressed } = await this.downloadLayersParallel(
      layers,
      async (layer, _idx, sig) => {
        const res = await fetch(`/oci/${ref.safeKey}/${layer.file}`, { signal: sig });
        if (!res.ok) throw new Error(`layer ${layer.file} download failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      },
      { emit, signal }
    );

    return this.finalizeImage(ref, {
      config: meta.config || {},
      digest: meta.digest || meta.configDigest || "",
      configDigest: meta.configDigest || meta.digest || "",
      layerIds,
      totalCompressed,
      totalUncompressed,
      emit,
    });
  }

  async pull(rawRef, { write, signal } = {}) {
    const ref = parseImageRef(rawRef);
    const emit = async (line) => {
      if (write) await write(line);
    };

    if (!ref.hasExplicitTag) {
      await emit(`Using default tag: ${ref.tag}\n`);
    }
    await emit(`${ref.tag}: Pulling from ${ref.repo}\n`);

    // 1. Try pre-bundled static OCI mirror (/oci/<safeKey>/)
    try {
      const staticHit = await this.pullStaticMirror(ref, { emit, signal });
      if (staticHit) return staticHit;
    } catch (err) {
      if (signal?.aborted) throw err;
    }

    // 2. Fall back to live registry proxy (/api/oci/*) when available
    let token;
    try {
      token = await fetchRegistryToken(ref);
    } catch {
      throw new Error(
        `image '${ref.fullName}' is not in the static mirror (available: hello-world, busybox, alpine, nginx:alpine-slim, python:3.13-alpine, doom)`
      );
    }
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    const base = `/api/oci/registry/${ref.registry}/v2/${ref.repo}`;

    const indexRes = await fetch(`${base}/manifests/${ref.tag}`, {
      signal,
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
    if (!indexRes.ok) {
      throw new Error(
        `pull access denied or image not found: ${ref.fullName} (HTTP ${indexRes.status})`
      );
    }

    let manifest = await indexRes.json();
    let manifestDigest = indexRes.headers.get("docker-content-digest") || "";

    if (manifest.manifests) {
      const arm64 =
        manifest.manifests.find(
          (m) => m.platform?.os === "linux" && m.platform?.architecture === "arm64"
        ) ||
        manifest.manifests.find(
          (m) => m.platform?.os === "linux" && m.platform?.architecture === "aarch64"
        );
      if (!arm64) {
        const avail = manifest.manifests
          .map((m) => `${m.platform?.os}/${m.platform?.architecture}`)
          .filter(Boolean)
          .join(", ");
        throw new Error(`no linux/arm64 manifest for ${ref.fullName} (available: ${avail})`);
      }
      manifestDigest = arm64.digest;
      const mRes = await fetch(`${base}/manifests/${arm64.digest}`, {
        signal,
        headers: {
          ...authHeaders,
          Accept: [
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
          ].join(", "),
        },
      });
      if (!mRes.ok) throw new Error(`manifest fetch failed (${mRes.status})`);
      manifest = await mRes.json();
    }

    const cfgRes = await fetch(`${base}/blobs/${manifest.config.digest}`, {
      signal,
      headers: authHeaders,
    });
    if (!cfgRes.ok) throw new Error(`config blob fetch failed (${cfgRes.status})`);
    const config = await cfgRes.json();

    const layers = manifest.layers || [];
    const { layerIds, totalCompressed, totalUncompressed } = await this.downloadLayersParallel(
      layers,
      async (layer, _idx, sig) => {
        const res = await fetch(`${base}/blobs/${layer.digest}`, {
          signal: sig,
          headers: authHeaders,
        });
        if (!res.ok) throw new Error(`layer ${layer.digest} download failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      },
      { emit, signal }
    );

    return this.finalizeImage(ref, {
      config: config.config || {},
      digest: manifestDigest || manifest.config.digest,
      configDigest: manifest.config.digest,
      layerIds,
      totalCompressed,
      totalUncompressed,
      emit,
    });
  }

  formatImagesTable() {
    const rows = [
      ["REPOSITORY", "TAG", "IMAGE ID", "ARCH", "SIZE"],
      ...this.list().map((img) => [
        img.ref.registry === "registry-1.docker.io"
          ? img.ref.displayRepo
          : `${img.ref.registry}/${img.ref.displayRepo}`,
        img.ref.tag,
        img.imageId,
        "arm64",
        img.sizeLabel,
      ]),
    ];

    const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)) + 3);
    return (
      rows
        .map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join(""))
        .join("\n") + "\n"
    );
  }
}
