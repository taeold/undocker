import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

/**
 * Streams an upstream HTTP(S) request, automatically following redirects (e.g. Docker Hub
 * 307 blob redirects to S3/Cloudflare R2) so browser fetch() never hits cross-origin CORS blocks.
 */
function proxyRequest(targetUrl, req, res, extraHeaders = {}, maxRedirects = 5) {
  const url = new URL(targetUrl);
  const lib = url.protocol === "https:" ? https : http;

  const headers = {
    "user-agent": "undocker-browser-oci/0.1",
    ...extraHeaders,
  };
  if (req.headers["accept"]) headers["accept"] = req.headers["accept"];
  if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];

  const upstream = lib.request(
    url,
    { method: req.method || "GET", headers },
    (upRes) => {
      const status = upRes.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status) && upRes.headers.location && maxRedirects > 0) {
        upRes.resume();
        const nextUrl = new URL(upRes.headers.location, url).toString();
        // Drop Authorization header when redirected to a different host (S3/CDN rejects Bearer tokens!)
        const nextHost = new URL(nextUrl).host;
        const nextReq = {
          method: req.method,
          headers:
            nextHost === url.host
              ? req.headers
              : { accept: req.headers["accept"] },
        };
        return proxyRequest(nextUrl, nextReq, res, {}, maxRedirects - 1);
      }

      const outHeaders = {
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "same-origin",
      };
      for (const h of [
        "content-type",
        "content-length",
        "docker-content-digest",
        "etag",
        "www-authenticate",
      ]) {
        if (upRes.headers[h]) outHeaders[h] = upRes.headers[h];
      }
      res.writeHead(status, outHeaders);
      upRes.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  upstream.end();
}

function ociProxyPlugin() {
  return {
    name: "dock-oci-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();

        // /api/oci/token?url=<encoded-token-url>  OR  /api/oci/docker-auth?...
        if (req.url.startsWith("/api/oci/docker-auth?")) {
          const qs = req.url.slice("/api/oci/docker-auth".length);
          return proxyRequest(`https://auth.docker.io/token${qs}`, req, res);
        }

        if (req.url.startsWith("/api/oci/ghcr-token?")) {
          // Serve local token cleanly for local ghcr.io/taeold/fbdoom dev image if present
          if (req.url.includes("taeold%2Ffbdoom") && fs.existsSync(path.resolve("fbdoom/oci-dist/meta.json"))) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ token: "local-dev-token" }));
          }
          const qs = req.url.slice("/api/oci/ghcr-token".length);
          return proxyRequest(`https://ghcr.io/token${qs}`, req, res);
        }

        if (req.url.startsWith("/api/oci/registry/")) {
          // Local OCI serving for ghcr.io/taeold/fbdoom while testing before GHCR publish
          const fbPrefix = "/api/oci/registry/ghcr.io/v2/taeold/fbdoom/";
          const fbMetaPath = path.resolve("fbdoom/oci-dist/meta.json");
          if (req.url.startsWith(fbPrefix) && fs.existsSync(fbMetaPath)) {
            const sub = req.url.slice(fbPrefix.length).split("?")[0];
            const meta = JSON.parse(fs.readFileSync(fbMetaPath, "utf8"));
            if (sub === "manifests/latest") {
              const body = fs.readFileSync(path.resolve("fbdoom/oci-dist/manifest.json"));
              res.writeHead(200, {
                "content-type": "application/vnd.oci.image.manifest.v1+json",
                "content-length": String(body.length),
              });
              return res.end(body);
            }
            if (sub === `blobs/${meta.configDigest}`) {
              const body = fs.readFileSync(path.resolve("fbdoom/oci-dist/config.json"));
              res.writeHead(200, {
                "content-type": "application/vnd.oci.image.config.v1+json",
                "content-length": String(body.length),
              });
              return res.end(body);
            }
            if (sub === `blobs/${meta.layerDigest}`) {
              const filePath = path.resolve("fbdoom/oci-dist/layer-0.tar.gz");
              const stat = fs.statSync(filePath);
              res.writeHead(200, {
                "content-type": "application/vnd.oci.image.layer.v1.tar+gzip",
                "content-length": String(stat.size),
              });
              return fs.createReadStream(filePath).pipe(res);
            }
          }

          // Format: /api/oci/registry/<host>/<path...>
          const rest = req.url.slice("/api/oci/registry/".length);
          const slashIdx = rest.indexOf("/");
          if (slashIdx === -1) return next();
          const host = rest.slice(0, slashIdx);
          const allowedHosts = new Set(["registry-1.docker.io", "ghcr.io", "quay.io"]);
          if (!allowedHosts.has(host)) {
            res.writeHead(403, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: `Registry host not allowed: ${host}` }));
          }
          const pathAndQuery = rest.slice(slashIdx);
          return proxyRequest(`https://${host}${pathAndQuery}`, req, res);
        }

        next();
      });
    },
  };
}

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
  optimizeDeps: {
    exclude: ["unkernel"],
  },
  build: {
    target: "esnext",
  },
  plugins: [ociProxyPlugin()],
});
