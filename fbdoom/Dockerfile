# Cross-compiles a tiny static linux/arm64 fbDOOM + shareware doom1.wad OCI image.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc-aarch64-linux-gnu \
      libc6-dev-arm64-cross \
      make \
      git \
      ca-certificates \
      curl \
      unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 https://github.com/maximevince/fbDOOM.git .
COPY i_input_evdev.c fbdoom/i_input_tty.c

# Build a zero-dependency static aarch64 binary
RUN make -j$(nproc) -C fbdoom \
      CROSS_COMPILE=aarch64-linux-gnu- \
      NOSDL=1 \
      CFLAGS="-O2 -Wall -DNORMALUNIX -DLINUX -DSNDSERV -Wno-unused-const-variable" \
      LDFLAGS="-static -Wl,--gc-sections" \
    && aarch64-linux-gnu-strip fbdoom/fbdoom

# Fetch classic 1993 DOOM shareware WAD (free to redistribute)
RUN curl -sSL "https://archive.org/download/DoomsharewareEpisode/doom.ZIP" -o /tmp/doom.zip \
    && mkdir -p /tmp/wad \
    && unzip -o /tmp/doom.zip -d /tmp/wad \
    && WAD=$(find /tmp/wad -iname "doom1.wad" | head -n 1) \
    && test -n "$WAD" \
    && cp "$WAD" /doom1.wad

FROM scratch
COPY --from=build /src/fbdoom/fbdoom /fbdoom
COPY --from=build /doom1.wad /doom1.wad
ENTRYPOINT ["/fbdoom", "-iwad", "/doom1.wad", "-scaling", "1"]
