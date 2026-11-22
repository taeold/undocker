/**
 * Ultra-lightweight entry point (~3 KB).
 * Zero static imports of unkernel, unkernel.wasm, or xterm.js — everything
 * heavy is lazily loaded only when the user clicks an example or focuses the terminal.
 */

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const idleScreen = document.getElementById("idle-screen");
const xtermMount = document.getElementById("xterm-mount");
const portPillsEl = document.getElementById("port-pills");
const previewUrlEl = document.getElementById("preview-url");
const previewIframe = document.getElementById("preview-iframe");
const fbWrap = document.getElementById("fb-wrap");
const fbCanvas = document.getElementById("fb-canvas");
const fbCtx = fbCanvas.getContext("2d");
const btnPreviewReload = document.getElementById("btn-preview-reload");
const btnPreviewOpen = document.getElementById("btn-preview-open");
const btnPreviewClose = document.getElementById("btn-preview-close");
const btnClear = document.getElementById("btn-clear");
const btnReset = document.getElementById("btn-reset");
const btnTheme = document.getElementById("btn-theme");
const footerStats = document.getElementById("footer-stats");

// ---------------- Theme Toggle ----------------
function syncThemeLabel() {
  const cur = document.documentElement.dataset.theme || "dark";
  btnTheme.textContent = cur === "dark" ? "light" : "dark";
}
syncThemeLabel();

btnTheme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  localStorage.setItem("undocker-theme", next);
  syncThemeLabel();
});

// ---------------- State & Progress UI ----------------
let runtime = null;
let bootPromise = null;
let pendingInput = "";
const openPorts = new Map();
let activePreviewPort = null;
let activePreviewPath = "/";
let fbActive = false;
let fbRaf = 0;

function setStatus(state, text) {
  statusDot.dataset.state = state;
  statusText.textContent = text;
}

function setIdleHtml(html) {
  idleScreen.innerHTML = html;
}

function updateFooter() {
  const imgs = runtime ? runtime.imageCount() : 0;
  const ports = openPorts.size;
  footerStats.textContent = `${imgs} image${imgs === 1 ? "" : "s"} · ${ports} published port${ports === 1 ? "" : "s"}`;
}

function renderPortPills() {
  portPillsEl.innerHTML = "";
  for (const info of openPorts.values()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "port-pill";
    btn.textContent = `:${info.hostPort}`;
    btn.title = `${info.image} (localhost:${info.hostPort} -> ${info.guestPort})`;
    btn.addEventListener("click", () => openPreview(info.hostPort));
    portPillsEl.appendChild(btn);
  }
  updateFooter();
}

function buildSrcdoc(res, reqPath) {
  const ct = (res.headers["content-type"] || res.headers["Content-Type"] || "text/plain").toLowerCase();
  const text = new TextDecoder().decode(new Uint8Array(res.body));

  if (ct.includes("text/html")) {
    const navHook = `<script>
document.addEventListener("click", function(e) {
  var a = e.target && e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  var href = a.getAttribute("href");
  if (!href || href.startsWith("#") || /^[a-z]+:/i.test(href)) return;
  e.preventDefault();
  var next = new URL(href, "http://localhost" + ${JSON.stringify(reqPath)});
  parent.postMessage({ type: "dock-preview-nav", path: next.pathname + next.search }, "*");
});
<\/script>`;
    return text.includes("</body>") ? text.replace("</body>", navHook + "</body>") : text + navHook;
  }

  return `<!doctype html><html><body style="margin:0;padding:16px;font:13px/1.6 ui-monospace,Menlo,monospace;background:#fafafa;color:#111;white-space:pre-wrap;word-break:break-word">${escapeHtml(
    text
  )}</body></html>`;
}

async function renderPreview(hostPort, reqPath = "/") {
  const mapping = openPorts.get(hostPort);
  if (!runtime || !mapping) return;

  activePreviewPort = hostPort;
  activePreviewPath = reqPath;
  previewUrlEl.textContent = `localhost:${hostPort}${reqPath} · connecting…`;
  document.body.classList.add("has-preview");
  requestAnimationFrame(() => runtime?.fit());

  const hasSw = Boolean(navigator.serviceWorker?.controller);
  btnPreviewOpen.style.display = hasSw ? "" : "none";
  if (hasSw) btnPreviewOpen.href = `/_preview/${hostPort}${reqPath}`;

  // Retry briefly until the container's server starts accepting connections on guestPort
  const deadline = performance.now() + 10_000;
  let lastErr = null;
  while (performance.now() < deadline && activePreviewPort === hostPort) {
    const t0 = performance.now();
    try {
      const res = await runtime.fetchGuest(mapping.guestPort, {
        method: "GET",
        path: reqPath,
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      if (activePreviewPort !== hostPort) return;
      const ms = Math.max(1, Math.round(performance.now() - t0));
      previewUrlEl.textContent = `localhost:${hostPort}${reqPath} · ${res.status} (${ms}ms)`;
      previewIframe.srcdoc = buildSrcdoc(res, reqPath);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  if (activePreviewPort === hostPort) {
    previewUrlEl.textContent = `localhost:${hostPort}${reqPath} · error`;
    previewIframe.srcdoc = `<!doctype html><html><body style="margin:0;padding:16px;font:13px/1.6 ui-monospace,monospace;color:#b91c1c;background:#fff">Could not reach container port ${mapping.guestPort}: ${escapeHtml(
      lastErr?.message || "timed out"
    )}</body></html>`;
  }
}

function showFramebuffer(mode) {
  if (!mode) {
    fbActive = false;
    if (fbRaf) cancelAnimationFrame(fbRaf);
    fbRaf = 0;
    fbWrap.classList.remove("active");
    if (activePreviewPort == null) {
      document.body.classList.remove("has-preview");
      requestAnimationFrame(() => runtime?.fit());
    } else {
      previewIframe.style.display = "";
    }
    return;
  }

  fbActive = true;
  fbCanvas.width = mode.width || 320;
  fbCanvas.height = mode.height || 200;
  previewIframe.style.display = "none";
  fbWrap.classList.add("active");
  btnPreviewReload.style.display = "none";
  btnPreviewOpen.style.display = "none";
  previewUrlEl.textContent = `/dev/fb0 · ${fbCanvas.width}×${fbCanvas.height}`;
  document.body.classList.add("has-preview");
  requestAnimationFrame(() => {
    runtime?.fit();
    fbCanvas.focus();
  });

  let imgData = fbCtx.createImageData(fbCanvas.width, fbCanvas.height);
  const loop = () => {
    if (!fbActive || !runtime) return;
    const f = runtime.frame();
    if (f && f.data) {
      if (f.width !== imgData.width || f.height !== imgData.height) {
        fbCanvas.width = f.width;
        fbCanvas.height = f.height;
        imgData = fbCtx.createImageData(f.width, f.height);
      }
      imgData.data.set(f.data);
      fbCtx.putImageData(imgData, 0, 0);
    }
    fbRaf = requestAnimationFrame(loop);
  };
  if (fbRaf) cancelAnimationFrame(fbRaf);
  fbRaf = requestAnimationFrame(loop);
}

fbCanvas.addEventListener("keydown", (e) => {
  if (!fbActive || !runtime) return;
  if (e.ctrlKey && e.code === "KeyC") {
    // Allow Ctrl+C to stop the foreground container cleanly!
    runtime.send("\x03");
    e.preventDefault();
    return;
  }
  runtime.sendKey(e.code, true);
  e.preventDefault();
});

fbCanvas.addEventListener("keyup", (e) => {
  if (!fbActive || !runtime) return;
  runtime.sendKey(e.code, false);
  e.preventDefault();
});

document.querySelectorAll(".fb-key").forEach((btn) => {
  const code = btn.dataset.key;
  const press = (e) => {
    e.preventDefault();
    runtime?.sendKey(code, true);
  };
  const release = (e) => {
    e.preventDefault();
    runtime?.sendKey(code, false);
  };
  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointerleave", release);
  btn.addEventListener("pointercancel", release);
});

async function openPreview(hostPort) {
  fbWrap.classList.remove("active");
  previewIframe.style.display = "";
  btnPreviewReload.style.display = "";
  await renderPreview(hostPort, "/");
}

function closePreview() {
  if (fbActive) {
    // Send Ctrl+C to cleanly stop the framebuffer container
    runtime?.send("\x03");
    showFramebuffer(null);
  }
  activePreviewPort = null;
  activePreviewPath = "/";
  document.body.classList.remove("has-preview");
  previewIframe.removeAttribute("srcdoc");
  previewIframe.src = "about:blank";
  requestAnimationFrame(() => runtime?.fit());
}

window.addEventListener("message", (event) => {
  if (event.data?.type === "dock-preview-nav" && activePreviewPort != null) {
    renderPreview(activePreviewPort, event.data.path || "/");
  }
});

btnPreviewReload.addEventListener("click", () => {
  if (activePreviewPort != null) {
    renderPreview(activePreviewPort, activePreviewPath);
  }
});
btnPreviewClose.addEventListener("click", closePreview);

// ---------------- Optional Service Worker (for "open ↗" in new tab) ----------------
async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/preview-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    navigator.serviceWorker.addEventListener("message", async (event) => {
      const msg = event.data;
      if (!msg || msg.type !== "dock-preview-fetch") return;
      const replyPort = event.ports[0];
      if (!replyPort) return;

      const mapping = openPorts.get(msg.hostPort);
      if (!runtime || !mapping) {
        replyPort.postMessage({ error: `No container listening on localhost:${msg.hostPort}.` });
        return;
      }

      try {
        const result = await runtime.fetchGuest(mapping.guestPort, msg);
        replyPort.postMessage(result, [result.body]);
      } catch (err) {
        replyPort.postMessage({ error: err?.message || String(err) });
      }
    });
  } catch {}
}
initServiceWorker();

// ---------------- Background Boot (after instant first paint) ----------------
async function ensureBooted(initialCmd = "") {
  if (runtime?.ready) {
    if (initialCmd) {
      await runtime.runCommand(initialCmd);
    } else if (pendingInput) {
      runtime.send(pendingInput);
      pendingInput = "";
    }
    runtime.focus();
    return;
  }

  if (initialCmd) {
    pendingInput += `${initialCmd}\r`;
  }

  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    const t0 = performance.now();
    setStatus("loading", "loading linux 7.x wasm…");

    try {
      const { createDockRuntime } = await import("./runtime.js");

      runtime = await createDockRuntime({
        container: xtermMount,
        onProgress(p) {
          if (p.stage === "download" && p.what === "kernel") {
            const mb = (p.loaded / 1048576).toFixed(1);
            const total = p.total ? ` / ${(p.total / 1048576).toFixed(1)} MB` : " MB";
            setStatus("loading", `downloading linux wasm · ${mb}${total}`);
          } else if (p.stage === "compile") {
            setStatus("loading", "compiling wasm…");
          } else if (p.stage === "instantiate") {
            setStatus("loading", "booting linux 7.x…");
          }
        },
        onPortOpen(info) {
          openPorts.set(info.hostPort, info);
          renderPortPills();
          openPreview(info.hostPort);
        },
        onPortClose(cid, hostPort) {
          let closedPort = null;
          for (const [hp, info] of openPorts.entries()) {
            if (info.cid === cid || (hostPort && hp === hostPort)) {
              openPorts.delete(hp);
              closedPort = hp;
            }
          }
          renderPortPills();
          if (closedPort != null && activePreviewPort === closedPort) closePreview();
        },
        onImageChange() {
          updateFooter();
        },
        onDisplay(mode) {
          showFramebuffer(mode);
        },
      });

      xtermMount.classList.add("active");
      idleScreen.style.display = "none";

      const totalMs = Math.round(performance.now() - t0);
      setStatus("ready", `linux ${runtime.kernelVer} · aarch64 · ${totalMs}ms`);
      updateFooter();

      if (pendingInput) {
        runtime.send(pendingInput);
        pendingInput = "";
      }
      if (document.activeElement === idleScreen) {
        runtime.focus();
      }
    } catch (err) {
      setStatus("error", "boot failed");
      setIdleHtml(
        `<span class="err">Failed to start unkernel:</span>\n${escapeHtml(err?.message || String(err))}`
      );
      bootPromise = null;
    }
  })();

  return bootPromise;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------- Interactions ----------------
document.querySelectorAll("#actions button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const cmd = btn.dataset.cmd || "";
    ensureBooted(cmd);
  });
});

idleScreen.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1) {
    pendingInput += e.key;
  } else if (e.key === "Enter") {
    pendingInput += "\r";
  }
});

btnClear.addEventListener("click", () => {
  runtime?.clear();
  runtime?.focus();
});

btnReset.addEventListener("click", async () => {
  openPorts.clear();
  renderPortPills();
  closePreview();
  pendingInput = "";
  if (runtime) {
    await runtime.dispose();
    runtime = null;
  }
  bootPromise = null;
  xtermMount.classList.remove("active");
  xtermMount.innerHTML = "";
  idleScreen.style.display = "";
  setIdleHtml("");
  updateFooter();
  ensureBooted();
});

// Start downloading & booting in the background right after first paint
requestAnimationFrame(() => {
  ensureBooted();
});
