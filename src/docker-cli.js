import { parseImageRef } from "./oci.js";

/**
 * Generates the real `/bin/docker` CLI script executed inside unkernel.
 * Calls the `_oci` HostCommand for registry pulls, image listings, and port preview notifications,
 * and uses real Linux overlayfs + unshare (PID/MNT/UTS/IPC namespaces) + chroot for containers.
 */
export const DOCKER_CLI_SCRIPT = `#!/bin/sh
set -eu

export PATH="/run/kw/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/kw/bin"
DOCKER_ROOT="/tmp/docker"
OCI_MNT="/mnt/oci"

ensure_storage() {
  if [ ! -d "$DOCKER_ROOT/layers" ]; then
    mkdir -p "$DOCKER_ROOT"
    mount -t tmpfs -o size=220M tmpfs "$DOCKER_ROOT" 2>/dev/null || true
    mkdir -p "$DOCKER_ROOT/layers" "$DOCKER_ROOT/images" "$DOCKER_ROOT/containers"
  fi
}

usage() {
  cat <<'EOF'
Usage:  docker [OPTIONS] COMMAND

Real Linux containers in WebAssembly (unkernel · overlayfs · namespaces)

Commands:
  pull        Download an arm64 OCI image from a registry
  run         Create and run a new container from an image
  images      List pulled images
  ps          List containers
  exec        Execute a command in a running container
  logs        Fetch the logs of a container
  stop        Stop a running container
  rm          Remove a container
  info        Display system-wide information
  version     Show the Docker & kernel version

Examples:
  docker run hello-world
  docker run -it alpine sh
  docker run -p 8080:80 nginx:alpine-slim
EOF
}

gen_cid() {
  # 12 hex chars from /proc/sys/kernel/random/uuid
  tr -d '-' < /proc/sys/kernel/random/uuid | cut -c1-12
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Unpack each content-addressed layer ONCE into /tmp/docker/layers/<digest>
# Shared layers (e.g. Alpine base across alpine, nginx, python3) are reused automatically!
prepare_image_layers() {
  IMG_KEY="$1"
  IMG_SRC="$OCI_MNT/images/$IMG_KEY"
  IMG_CACHE="$DOCKER_ROOT/images/$IMG_KEY"

  if [ -f "$IMG_CACHE/.ready" ]; then
    return 0
  fi

  mkdir -p "$IMG_CACHE"
  LOWER=""
  while IFS= read -r LID; do
    [ -n "$LID" ] || continue
    LDIR="$DOCKER_ROOT/layers/$LID"
    if [ ! -f "$LDIR/.unpacked" ]; then
      mkdir -p "$LDIR"
      tar -xf "$OCI_MNT/layers/$LID.tar" -C "$LDIR" 2>/dev/null || true

      # Convert OCI whiteouts (.wh.<name>) into overlayfs whiteout char devices (0/0)
      find "$LDIR" -name '.wh.*' 2>/dev/null | while IFS= read -r wh; do
        base=$(basename "$wh")
        dir=$(dirname "$wh")
        if [ "$base" = ".wh..wh..opq" ]; then
          rm -f "$wh"
        else
          target="$dir/\${base#.wh.}"
          rm -f "$wh"
          mknod "$target" c 0 0 2>/dev/null || true
        fi
      done
      touch "$LDIR/.unpacked"
    fi

    if [ -z "$LOWER" ]; then
      LOWER="$LDIR"
    else
      LOWER="$LDIR:$LOWER"
    fi
  done < "$IMG_SRC/layers.list"

  printf '%s' "$LOWER" > "$IMG_CACHE/lowerdir"
  touch "$IMG_CACHE/.ready"
}

find_container() {
  Q="$1"
  for d in "$DOCKER_ROOT/containers"/*; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    cname=$(cat "$d/name" 2>/dev/null || true)
    case "$id" in "$Q"*) echo "$id"; return 0 ;; esac
    if [ "$cname" = "$Q" ]; then echo "$id"; return 0; fi
  done
  return 1
}

cmd_run() {
  ensure_storage
  DETACH=0
  RM_AFTER=0
  CUSTOM_NAME=""
  CUSTOM_WORKDIR=""
  CUSTOM_ENTRYPOINT=""
  HAS_CUSTOM_EP=0
  HOST_PORT=""
  GUEST_PORT=""
  EXTRA_ENV=""
  IMAGE=""

  while [ $# -gt 0 ]; do
    case "$1" in
      -d|--detach) DETACH=1; shift ;;
      --rm) RM_AFTER=1; shift ;;
      -i|--interactive|-t|--tty|-it|-ti) shift ;;
      -itd|-idt|-tid|-tdi|-dit|-dti|-id|-di|-td|-dt) DETACH=1; shift ;;
      -p|--publish)
        shift
        PORT_SPEC="$1"
        case "$PORT_SPEC" in
          *:*)
            HOST_PORT="\${PORT_SPEC%%:*}"
            GUEST_PORT="\${PORT_SPEC##*:}"
            ;;
          *)
            HOST_PORT="$PORT_SPEC"
            GUEST_PORT="$PORT_SPEC"
            ;;
        esac
        shift
        ;;
      -e|--env)
        shift
        EXTRA_ENV="$EXTRA_ENV $(shell_quote "$1")"
        shift
        ;;
      --name)
        shift
        CUSTOM_NAME="$1"
        shift
        ;;
      -w|--workdir)
        shift
        CUSTOM_WORKDIR="$1"
        shift
        ;;
      --entrypoint)
        shift
        CUSTOM_ENTRYPOINT="$1"
        HAS_CUSTOM_EP=1
        shift
        ;;
      --)
        shift
        break
        ;;
      -*)
        echo "docker: unknown flag: $1" >&2
        exit 125
        ;;
      *)
        IMAGE="$1"
        shift
        break
        ;;
    esac
  done

  if [ -z "$IMAGE" ]; then
    echo "docker: 'run' requires at least 1 argument (an image name)." >&2
    exit 125
  fi

  # Pull image if not already in host OCI store; returns safeKey on stdout
  IMG_KEY=$(_oci ensure "$IMAGE")
  IMG_SRC="$OCI_MNT/images/$IMG_KEY"

  prepare_image_layers "$IMG_KEY"
  LOWER=$(cat "$DOCKER_ROOT/images/$IMG_KEY/lowerdir")

  CID=$(gen_cid)
  CNAME="\${CUSTOM_NAME:-undocker_$CID}"
  CDIR="$DOCKER_ROOT/containers/$CID"
  mkdir -p "$CDIR/upper" "$CDIR/work" "$CDIR/merged"

  # Mount real Linux overlayfs stacking cached image layers + writable upper layer
  mount -t overlay overlay -o "lowerdir=$LOWER,upperdir=$CDIR/upper,workdir=$CDIR/work" "$CDIR/merged"

  # Minimal container virtual filesystems & networking config
  mkdir -p "$CDIR/merged/proc" "$CDIR/merged/sys" "$CDIR/merged/dev" "$CDIR/merged/etc"
  mount --bind /dev "$CDIR/merged/dev" 2>/dev/null || true
  mount -t sysfs sysfs "$CDIR/merged/sys" 2>/dev/null || true
  if [ ! -f "$CDIR/merged/etc/hosts" ]; then
    printf "127.0.0.1 localhost %s\\n" "$CID" > "$CDIR/merged/etc/hosts"
  fi
  if [ -f /etc/resolv.conf ] && [ ! -f "$CDIR/merged/etc/resolv.conf" ]; then
    cp /etc/resolv.conf "$CDIR/merged/etc/resolv.conf" 2>/dev/null || true
  fi

  # Resolve final command (Entrypoint + Cmd / user override)
  USER_ARGS=""
  for a in "$@"; do
    USER_ARGS="$USER_ARGS $(shell_quote "$a")"
  done

  if [ "$HAS_CUSTOM_EP" -eq 1 ]; then
    RUN_ARGS="$(shell_quote "$CUSTOM_ENTRYPOINT") $USER_ARGS"
  elif [ -n "$USER_ARGS" ]; then
    EP_ARGS=$(cat "$IMG_SRC/entrypoint.args")
    if [ -n "$EP_ARGS" ]; then
      RUN_ARGS="$EP_ARGS $USER_ARGS"
    else
      RUN_ARGS="$USER_ARGS"
    fi
  else
    EP_ARGS=$(cat "$IMG_SRC/entrypoint.args")
    CMD_ARGS=$(cat "$IMG_SRC/cmd.args")
    RUN_ARGS="$EP_ARGS $CMD_ARGS"
  fi

  IMG_ENV=$(cat "$IMG_SRC/env.args")
  WORKDIR="\${CUSTOM_WORKDIR:-$(cat "$IMG_SRC/workdir")}"
  [ -n "$WORKDIR" ] || WORKDIR="/"

  # Record container metadata
  printf '%s' "$IMAGE" > "$CDIR/image"
  printf '%s' "$CNAME" > "$CDIR/name"
  printf '%s' "$RUN_ARGS" > "$CDIR/cmd"
  printf '%s' "running" > "$CDIR/status"
  if [ -n "$HOST_PORT" ]; then
    printf '%s:%s' "$HOST_PORT" "$GUEST_PORT" > "$CDIR/ports"
  else
    printf '' > "$CDIR/ports"
  fi

  # Build inner namespace exec script.
  # Putting /bin/env OUTSIDE chroot makes FROM scratch images (like hello-world!) work seamlessly!
  cat > "$CDIR/exec.sh" <<EOF_EXEC
#!/bin/sh
hostname "$CID" 2>/dev/null || true
mount -t proc proc "$CDIR/merged/proc" 2>/dev/null || true
EOF_EXEC

  if [ "$WORKDIR" != "/" ] && [ -x "$CDIR/merged/bin/sh" ]; then
    cat >> "$CDIR/exec.sh" <<EOF_EXEC
exec /bin/env -i $IMG_ENV $EXTRA_ENV /bin/chroot "$CDIR/merged" /bin/sh -c "cd $(shell_quote "$WORKDIR") && exec $RUN_ARGS"
EOF_EXEC
  else
    cat >> "$CDIR/exec.sh" <<EOF_EXEC
exec /bin/env -i $IMG_ENV $EXTRA_ENV /bin/chroot "$CDIR/merged" $RUN_ARGS
EOF_EXEC
  fi
  chmod +x "$CDIR/exec.sh"

  if [ -n "$HOST_PORT" ]; then
    # Fail cleanly if another running container already holds this host or guest port
    for d in "$DOCKER_ROOT/containers"/*; do
      [ -d "$d" ] || continue
      if [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then
        ep=$(cat "$d/ports" 2>/dev/null || true)
        if [ -n "$ep" ]; then
          eh="\${ep%%:*}"
          eg="\${ep##*:}"
          if [ "$eh" = "$HOST_PORT" ] || [ "$eg" = "$GUEST_PORT" ]; then
            echo "docker: Error: port $HOST_PORT (or container port $GUEST_PORT) is already allocated by $(basename "$d")." >&2
            exit 125
          fi
        fi
      fi
    done
    _oci port-open "$HOST_PORT" "$GUEST_PORT" "$CID" "$IMAGE" >/dev/null 2>&1 || true
  fi

  if [ "$DETACH" -eq 1 ]; then
    setsid unshare --pid --mount --uts --ipc --fork "$CDIR/exec.sh" > "$CDIR/logs" 2>&1 &
    CPID=$!
    printf '%s' "$CPID" > "$CDIR/pid"
    printf '%s\\n' "$CID"
    return 0
  fi

  # Foreground execution directly on the live PTY!
  _oci fg-start "$CID" >/dev/null 2>&1 || true
  set +e
  unshare --pid --mount --uts --ipc --fork "$CDIR/exec.sh"
  RC=$?
  set -e
  _oci fg-end "$CID" >/dev/null 2>&1 || true

  printf 'exited (%s)' "$RC" > "$CDIR/status"
  if [ -n "$HOST_PORT" ]; then
    _oci port-close "$CID" "$HOST_PORT" >/dev/null 2>&1 || true
  fi

  if [ "$RM_AFTER" -eq 1 ]; then
    umount -l "$CDIR/merged/dev" "$CDIR/merged/sys" "$CDIR/merged/proc" "$CDIR/merged" 2>/dev/null || true
    rm -rf "$CDIR"
  fi

  return "$RC"
}

cmd_ps() {
  ensure_storage
  SHOW_ALL=0
  [ "\${1:-}" = "-a" ] && SHOW_ALL=1
  printf "%-14s %-22s %-14s %-24s %s\\n" "CONTAINER ID" "IMAGE" "STATUS" "PORTS" "NAMES"
  for d in "$DOCKER_ROOT/containers"/*; do
    [ -d "$d" ] || continue
    cid=$(basename "$d")
    img=$(cat "$d/image" 2>/dev/null || echo "-")
    cname=$(cat "$d/name" 2>/dev/null || echo "-")
    ports=$(cat "$d/ports" 2>/dev/null || true)
    st=$(cat "$d/status" 2>/dev/null || echo "unknown")
    if [ "$st" = "running" ] && [ -f "$d/pid" ]; then
      pid=$(cat "$d/pid")
      if kill -0 "$pid" 2>/dev/null; then
        st="Up"
      else
        st="Exited"
        printf '%s' "$st" > "$d/status"
      fi
    fi
    if [ "$SHOW_ALL" -eq 0 ] && [ "$st" != "Up" ] && [ "$st" != "running" ]; then
      continue
    fi
    port_disp=""
    [ -n "$ports" ] && port_disp="localhost:\${ports%%:*}->\${ports##*:}/tcp"
    printf "%-14s %-22s %-14s %-24s %s\\n" "$cid" "$img" "$st" "$port_disp" "$cname"
  done
}

cmd_stop() {
  ensure_storage
  for target in "$@"; do
    CID=$(find_container "$target" || true)
    if [ -z "$CID" ]; then
      echo "Error: No such container: $target" >&2
      continue
    fi
    CDIR="$DOCKER_ROOT/containers/$CID"
    if [ -f "$CDIR/pid" ]; then
      PID=$(cat "$CDIR/pid")
      # Kill the entire process group (-$PID) so unshare + PID 1 + worker children all terminate!
      kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
      pkill -TERM -P "$PID" 2>/dev/null || true
      sleep 0.1
      kill -KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
      pkill -KILL -P "$PID" 2>/dev/null || true
    fi
    printf 'stopped' > "$CDIR/status"
    EPORTS=$(cat "$CDIR/ports" 2>/dev/null || true)
    EHOST="\${EPORTS%%:*}"
    _oci port-close "$CID" "$EHOST" >/dev/null 2>&1 || true
    printf '%s\\n' "$target"
  done
}

cmd_rm() {
  ensure_storage
  for target in "$@"; do
    [ "$target" = "-f" ] && continue
    CID=$(find_container "$target" || true)
    if [ -z "$CID" ]; then
      echo "Error: No such container: $target" >&2
      continue
    fi
    cmd_stop "$CID" >/dev/null 2>&1 || true
    CDIR="$DOCKER_ROOT/containers/$CID"
    umount -l "$CDIR/merged/dev" "$CDIR/merged/sys" "$CDIR/merged/proc" "$CDIR/merged" 2>/dev/null || true
    rm -rf "$CDIR"
    printf '%s\\n' "$target"
  done
}

cmd_logs() {
  ensure_storage
  CID=$(find_container "\${1:-}" || true)
  if [ -z "$CID" ]; then
    echo "Error: No such container: \${1:-}" >&2
    exit 1
  fi
  cat "$DOCKER_ROOT/containers/$CID/logs" 2>/dev/null || true
}

cmd_exec() {
  ensure_storage
  while [ $# -gt 0 ]; do
    case "$1" in
      -i|-t|-it|-ti) shift ;;
      *) break ;;
    esac
  done
  TARGET="\${1:-}"
  shift || true
  CID=$(find_container "$TARGET" || true)
  if [ -z "$CID" ]; then
    echo "Error: No such container: $TARGET" >&2
    exit 1
  fi
  CDIR="$DOCKER_ROOT/containers/$CID"
  if [ -f "$CDIR/pid" ] && kill -0 "$(cat "$CDIR/pid")" 2>/dev/null; then
    exec nsenter -t "$(cat "$CDIR/pid")" -p -m -u -i chroot "$CDIR/merged" "$@"
  else
    exec chroot "$CDIR/merged" "$@"
  fi
}

SUB="\${1:-}"
[ -n "$SUB" ] && shift

case "$SUB" in
  pull) _oci pull "$@" ;;
  images) _oci images ;;
  run) cmd_run "$@" ;;
  ps) cmd_ps "$@" ;;
  stop|kill) cmd_stop "$@" ;;
  rm) cmd_rm "$@" ;;
  logs) cmd_logs "$@" ;;
  exec) cmd_exec "$@" ;;
  version|-v|--version)
    echo "undocker version 0.1.0 (unkernel Linux $(uname -r) / $(uname -m) · wasm)"
    ;;
  info)
    echo "Client: undocker (browser-native OCI)"
    echo "Server: unkernel Linux $(uname -r)"
    echo "OSType: linux"
    echo "Architecture: $(uname -m)"
    echo "Storage Driver: overlay2 (real kernel overlayfs)"
    echo "Isolation: unshare (pid, mnt, uts, ipc) + chroot"
    ;;
  ""|-h|--help|help) usage ;;
  *)
    echo "docker: '$SUB' is not a docker command." >&2
    echo "See 'docker --help'" >&2
    exit 1
    ;;
esac
`;

/**
 * Creates the `_oci` HostCommand handler passed to `createKernel({ commands: { _oci } })`.
 */
export function createOciHostCommand(
  ociStore,
  { onPortOpen, onPortClose, onImageChange, onFgChange }
) {
  return async (ctx) => {
    const [action, ...args] = ctx.args;
    const outWriter = ctx.stdout.getWriter();
    const errWriter = ctx.stderr.getWriter();

    const writeOut = async (text) => {
      await outWriter.write(text);
    };
    const writeErr = async (text) => {
      await errWriter.write(text);
    };

    try {
      if (action === "pull") {
        const ref = args[0];
        if (!ref) {
          await writeErr("docker pull: requires an image name\n");
          return 1;
        }
        await ociStore.pull(ref, { write: writeOut, signal: ctx.signal });
        onImageChange?.(ociStore.list());
        return 0;
      }

      if (action === "ensure") {
        const rawRef = args[0];
        if (!rawRef) {
          await writeErr("docker: missing image name\n");
          return 1;
        }
        const parsed = parseImageRef(rawRef);
        if (!ociStore.get(rawRef)) {
          // Print progress to stderr so stdout cleanly returns ONLY the safeKey for $(...) capture!
          await writeErr(`Unable to find image '${parsed.fullName}' locally\n`);
          await ociStore.pull(rawRef, { write: writeErr, signal: ctx.signal });
          onImageChange?.(ociStore.list());
        }
        await writeOut(`${parsed.safeKey}\n`);
        return 0;
      }

      if (action === "images") {
        await writeOut(ociStore.formatImagesTable());
        return 0;
      }

      if (action === "port-open") {
        const [hostPort, guestPort, cid, image] = args;
        onPortOpen?.({
          hostPort: Number(hostPort),
          guestPort: Number(guestPort),
          cid,
          image,
        });
        return 0;
      }

      if (action === "port-close") {
        const [cid, hostPort] = args;
        onPortClose?.(cid, hostPort ? Number(hostPort) : null);
        return 0;
      }

      if (action === "fg-start") {
        onFgChange?.(args[0] || true);
        return 0;
      }

      if (action === "fg-end") {
        onFgChange?.(null);
        return 0;
      }

      await writeErr(`_oci: unknown action '${action || ""}'\n`);
      return 1;
    } catch (err) {
      await writeErr(`Error: ${err?.message || String(err)}\n`);
      return 1;
    } finally {
      try {
        await outWriter.close();
      } catch {}
      try {
        await errWriter.close();
      } catch {}
    }
  };
}
