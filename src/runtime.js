/**
 * Lazily-loaded runtime chunk: xterm.js + unkernel + unkernel.wasm + OCI store.
 * Not fetched until the user actually clicks a command or opens the shell.
 */

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { checkSupport, createKernel, domCodeToLinux, MemoryFs } from "unkernel";
import kernelWasmUrl from "unkernel/unkernel.wasm?url";

import { OciStore } from "./oci.js";
import { createOciHostCommand, DOCKER_CLI_SCRIPT } from "./docker-cli.js";

export async function createDockRuntime({
  container,
  onProgress,
  onPortOpen,
  onPortClose,
  onImageChange,
  onDisplay,
}) {
  const support = await checkSupport();
  if (!support.ok) {
    throw new Error(`Browser missing WebAssembly JSPI support: ${support.problems.join(", ")}`);
  }

  const memFs = new MemoryFs();
  memFs.mkdirp("/bin");
  memFs.mkdirp("/images");
  memFs.writeFile("/bin/docker", DOCKER_CLI_SCRIPT);

  let fgCid = null;
  let fgWaiters = [];

  const ociStore = new OciStore(memFs);
  const ociCommand = createOciHostCommand(ociStore, {
    onPortOpen,
    onPortClose,
    onImageChange,
    onFgChange(cid) {
      fgCid = cid;
      if (!cid && fgWaiters.length) {
        const list = fgWaiters;
        fgWaiters = [];
        list.forEach((fn) => fn());
      }
    },
  });

  const tBoot = performance.now();
  const vm = await createKernel({
    kernel: kernelWasmUrl,
    memoryMiB: 256,
    display: { width: 320, height: 200 },
    onDisplay,
    onProgress,
    mounts: {
      "/mnt/oci": memFs,
    },
    commands: {
      _oci: ociCommand,
    },
  });

  const setup = await vm.exec("sh", [
    "-c",
    "cp /mnt/oci/bin/docker /bin/docker && chmod +x /bin/docker && uname -r",
  ]);
  const kernelVer = setup.stdout.trim() || "7.x";
  const bootMs = Math.round(performance.now() - tBoot);

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.4,
    scrollback: 5000,
    theme: {
      background: "#0c0c0c",
      foreground: "#e5e5e5",
      cursor: "#ededed",
      cursorAccent: "#0c0c0c",
      selectionBackground: "rgba(255, 255, 255, 0.2)",
      black: "#171717",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#facc15",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#e5e5e5",
      brightBlack: "#525252",
      brightRed: "#fca5a5",
      brightGreen: "#86efac",
      brightYellow: "#fde047",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#5eead4",
      brightWhite: "#ffffff",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(container);
  fitAddon.fit();

  const shell = await vm.spawn("sh", [], {
    cols: Math.max(20, term.cols),
    rows: Math.max(8, term.rows),
    env: {
      TERM: "xterm-256color",
      HOME: "/root",
      PATH: "/run/kw/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/kw/bin",
      PS1: "\\[\\033[1;37m\\]undocker\\[\\033[0m\\]:\\[\\033[90m\\]\\w\\[\\033[0m\\]$ ",
    },
  });

  // Wait for the very first prompt chunk from sh before swapping xterm in,
  // so there is never an empty frame between the idle prompt and live xterm.
  let resolveFirstChunk;
  const firstChunkReady = new Promise((r) => {
    resolveFirstChunk = r;
  });
  const firstChunkTimeout = setTimeout(resolveFirstChunk, 400);

  const reader = shell.output.getReader();
  (async () => {
    let seenFirst = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        term.write(value, () => {
          if (!seenFirst) {
            seenFirst = true;
            clearTimeout(firstChunkTimeout);
            resolveFirstChunk();
          }
        });
      }
    } catch {}
    if (!seenFirst) {
      clearTimeout(firstChunkTimeout);
      resolveFirstChunk();
    }
  })();

  await firstChunkReady;

  const dataDisposable = term.onData((data) => {
    shell.write(data);
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!container.classList.contains("active")) return;
    fitAddon.fit();
    shell.resize(Math.max(20, term.cols), Math.max(8, term.rows));
  });
  resizeObserver.observe(container);

  return {
    ready: true,
    kernelVer,
    send(text) {
      shell.write(text);
    },
    async runCommand(cmd) {
      // If a foreground container (e.g. python3 REPL, alpine sh, or doom) is active,
      // exit it cleanly back to the host shell before running the next button command.
      if (fgCid) {
        const exited = new Promise((resolve) => {
          const timer = setTimeout(resolve, 1200);
          fgWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        // Ctrl+C interrupts running programs (doom / loops), Ctrl+D exits REPLs/shells (python3 / sh)
        shell.write("\x03");
        await new Promise((r) => setTimeout(r, 60));
        if (fgCid) shell.write("\x04");
        await exited;
        await new Promise((r) => setTimeout(r, 80));
      }
      // Clear any half-typed input on the host prompt and run the command
      shell.write(`\x15${cmd}\r`);
    },
    focus() {
      term.focus();
    },
    clear() {
      term.clear();
    },
    fit() {
      fitAddon.fit();
      shell.resize(Math.max(20, term.cols), Math.max(8, term.rows));
    },
    imageCount() {
      return ociStore.list().length;
    },
    frame() {
      return vm.frame();
    },
    sendKey(domCode, down) {
      const code = domCodeToLinux(domCode);
      if (code) vm.evdev.key(code, down);
    },
    async fetchGuest(guestPort, msg) {
      const res = await vm.fetch(`http://localhost:${guestPort}${msg.path}`, {
        method: msg.method,
        headers: msg.headers,
        body: msg.body ? new Uint8Array(msg.body) : undefined,
      });
      const headers = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const body = await res.arrayBuffer();
      return {
        status: res.status,
        statusText: res.statusText,
        headers,
        body,
      };
    },
    async dispose() {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      try {
        shell.close();
      } catch {}
      try {
        term.dispose();
      } catch {}
      try {
        await vm.stop();
      } catch {}
    },
  };
}
