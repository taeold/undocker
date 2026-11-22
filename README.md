# undocker

Run unmodified `linux/arm64` OCI images in a browser tab.

https://undocker.web.app

## How

Built on [unkernel](https://github.com/pithings/unkernel), Linux compiled to WebAssembly.

The browser downloads OCI image layers, gunzips them with `DecompressionStream`, and mounts them into Linux over `9p`. A small `/bin/docker` script unpacks layers into `tmpfs`, stacks them with `overlayfs`, and runs containers with `unshare` and `chroot`.

## Limits

- Not `dockerd`—a minimal runner for `pull`, `run`, `ps`, `images`, `exec`, `logs`, and `kill`.
- Because Docker Hub and GHCR don't send CORS headers, the static site mirrors a small set of starter images (`hello-world`, `busybox`, `alpine`, `nginx:alpine-slim`, `python:3.13-alpine`, `fbdoom`). Local dev includes a CORS proxy for pulling arbitrary `arm64` images.
- No `iptables` bridge networking or `seccomp`.

## License

MIT
