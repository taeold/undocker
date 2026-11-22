// Service Worker: intercepts /_preview/<hostPort>/<path> and proxies HTTP
// requests to the active page, which forwards them over AF_VSOCK via vm.fetch().

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/_preview/")) return;

  event.respondWith(handlePreviewRequest(event.request, url));
});

async function handlePreviewRequest(request, url) {
  // Path format: /_preview/<hostPort>/<rest...>
  const match = url.pathname.match(/^\/_preview\/(\d+)(\/.*)?$/);
  if (!match) {
    return new Response("Invalid preview path", { status: 400 });
  }

  const hostPort = Number(match[1]);
  const forwardPath = (match[2] || "/") + url.search;

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const targetClient = clients.find((c) => c.visibilityState === "visible") || clients[0];

  if (!targetClient) {
    return new Response("No active dock terminal window found.", { status: 503 });
  }

  const headers = {};
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "host") headers[key] = value;
  });

  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      resolve(
        new Response("504 Gateway Timeout: container did not respond in time.", {
          status: 504,
          headers: { "content-type": "text/plain" },
        })
      );
    }, 15_000);

    channel.port1.onmessage = (ev) => {
      clearTimeout(timer);
      const data = ev.data;
      if (data.error) {
        resolve(
          new Response(`502 Bad Gateway\n\n${data.error}`, {
            status: 502,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cross-origin-resource-policy": "same-origin",
            },
          })
        );
        return;
      }

      const resHeaders = new Headers(data.headers || {});
      resHeaders.set("cross-origin-resource-policy", "same-origin");
      resolve(
        new Response(data.body ?? null, {
          status: data.status || 200,
          statusText: data.statusText || "",
          headers: resHeaders,
        })
      );
    };

    const transfer = body ? [channel.port2, body] : [channel.port2];
    targetClient.postMessage(
      {
        type: "dock-preview-fetch",
        hostPort,
        method: request.method,
        path: forwardPath,
        headers,
        body,
      },
      transfer
    );
  });
}
