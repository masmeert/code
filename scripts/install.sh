#!/bin/sh
# Installs MassCode's daemon on a Linux machine as `masscode`:
#   curl -fsSL https://github.com/masmeert/code/releases/latest/download/install.sh | sh
# MASSCODE_VERSION picks a release (default: the latest); MASSCODE_DATA_DIR moves ~/.masscode.
set -eu

releases="${MASSCODE_RELEASES_URL:-https://github.com/masmeert/code/releases}"
data_dir="${MASSCODE_DATA_DIR:-$HOME/.masscode}"
bin_dir="$data_dir/bin"
launcher_dir="$HOME/.local/bin"

fail() {
  echo "✗ $1" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "This installer sets up Linux machines. On a Mac, download the MassCode app instead."

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "MassCode runs on x64 and arm64 Linux; this machine is $(uname -m)." ;;
esac

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -q -O "$2" "$1"; }
else
  fail "Install curl or wget, then run this again."
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  hash() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "Install sha256sum (coreutils), then run this again."
fi

if [ -n "${MASSCODE_VERSION:-}" ]; then
  url="$releases/download/v${MASSCODE_VERSION#v}"
else
  url="$releases/latest/download"
fi

asset="masscode-daemon-linux-$arch.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Downloading MassCode…"
download "$url/SHA256SUMS" "$work/SHA256SUMS" || fail "Couldn't download MassCode's checksums from GitHub. Check this machine's connection, then retry."
download "$url/$asset" "$work/$asset" || fail "Couldn't download MassCode from GitHub. Check this machine's connection, then retry."

expected=$(grep " \*\{0,1\}$asset\$" "$work/SHA256SUMS" | cut -d ' ' -f 1)
[ -n "$expected" ] || fail "This release has no build for $arch Linux."
[ "$(hash "$work/$asset")" = "$expected" ] || fail "The download doesn't match its checksum, so nothing was installed. Retry; if it keeps failing, report it."

gzip -dc "$work/$asset" > "$work/masscode"
chmod +x "$work/masscode"
version=$(MASSCODE_SKIP_SHELL_ENV=1 "$work/masscode" --version) || fail "The downloaded MassCode doesn't run on this machine."

mkdir -p "$bin_dir" "$launcher_dir"
mv "$work/masscode" "$bin_dir/masscode-$version"
ln -sfn "masscode-$version" "$bin_dir/masscode"
ln -sfn "$bin_dir/masscode" "$launcher_dir/masscode"

for file in "$bin_dir"/masscode-*; do
  [ "$(basename "$file")" = "masscode-$version" ] || rm -f "$file"
done

echo "✓ Installed MassCode $version"

if systemctl --user is-active --quiet masscode 2>/dev/null; then
  systemctl --user kill --kill-whom=main --signal=SIGUSR2 masscode
  echo "MassCode already runs here; it restarts on $version once its agents are idle."
  exit 0
fi

case ":$PATH:" in
  *":$launcher_dir:"*) next="masscode connect" ;;
  *)
    echo "$launcher_dir isn't on your PATH. Add it with:"
    echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile && . ~/.profile"
    next="$launcher_dir/masscode connect"
    ;;
esac

echo "Next, run: $next"
