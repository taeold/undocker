# undocker

Run unmodified `linux/arm64` Docker/OCI container images directly in a browser tab.

Live demo: **https://undocker.web.app**

## How it works

`undocker` is a lightweight (~450-line) OCI container runner built on top of [**unkernel**](https://github.com/pithings/unkernel) (a real Linux 7.x kernel compiled to WebAssembly):

1. **OCI image puller ([`src/oci.js`](src/oci.js))** — Pulls `linux/arm64` OCI manifests & layers (from a static CDN mirror or via `/api/oci/*` registry proxy in dev), deduplicates shared layers by SHA-256 digest, gunzips them natively in the browser with `DecompressionStream`, and mounts them into Linux via `unkernel`'s `9p` `MemoryFs`.
2. **Container runtime ([`src/docker-cli.js`](src/docker-cli.js))** — Exposes a familiar `docker` CLI (`pull`, `run`, `images`, `ps`, `exec`, `logs`, `stop`, `kill`, `rm`) using Linux's real built-in `overlayfs`, `unshare` (`--pid --mount --uts --ipc`), and `chroot`.
3. **Port & display bridges ([`src/main.js`](src/main.js), [`src/runtime.js`](src/runtime.js))** — Published ports (`-p 8080:80`) proxy HTTP straight to container loopback via `unkernel`'s `vm.fetch()` over `AF_VSOCK`. Framebuffer apps (`fbdoom`) draw straight to `/dev/fb0` and render onto a `<canvas>` with `evdev` keyboard/touch input.

## Local development

```sh
npm install
npm run dev
```

In local dev, [`vite.config.js`](vite.config.js) includes a `/api/oci/*` CORS proxy so `docker pull` / `docker run` works with arbitrary public `linux/arm64` images on Docker Hub and GHCR.

## Static Firebase Hosting deploy

```sh
npm run bundle:oci   # pre-bundle starter linux/arm64 images into public/oci/
npm run deploy       # vite build + deploy to Firebase Hosting via gcloud token
```

## Building the `fbdoom` image

[`fbdoom/Dockerfile`](fbdoom/Dockerfile) cross-compiles a static `linux/arm64` `fbDOOM` binary with an `evdev` input driver ([`fbdoom/i_input_evdev.c`](fbdoom/i_input_evdev.c)) and packages it with the 1993 shareware `doom1.wad` into a ~2.2 MB `FROM scratch` OCI image.

## Credits

Powered by [**unkernel**](https://github.com/pithings/unkernel) by Pooya Parsa (`pithings`).

## License

MIT
