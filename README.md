# undocker

Run unmodified `linux/arm64` Docker/OCI container images in a browser tab.

https://undocker.web.app

## How

Built on top of [unkernel](https://github.com/pithings/unkernel) (a real Linux 7.x kernel compiled to WebAssembly):

- [`src/oci.js`](src/oci.js) pulls `linux/arm64` OCI manifests and layers, deduplicates shared layers by SHA-256 digest, gunzips them in the browser with `DecompressionStream`, and mounts them into Linux over `9p`.
- [`src/docker-cli.js`](src/docker-cli.js) implements a minimal `docker` CLI (`pull`, `run`, `images`, `ps`, `exec`, `logs`, `stop`, `kill`, `rm`) using Linux's real `overlayfs`, `unshare` namespaces, and `chroot`.
- [`src/main.js`](src/main.js) and [`src/runtime.js`](src/runtime.js) bridge published ports (`-p 8080:80`) via `AF_VSOCK` (`vm.fetch()`) and render framebuffer containers like [`fbdoom`](fbdoom/Dockerfile) straight from `/dev/fb0` onto a `<canvas>`.

## License

MIT
