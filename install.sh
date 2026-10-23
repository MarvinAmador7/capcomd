#!/bin/sh
# Install capcomd, one self-contained executable (no Bun or Node needed):
#   curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh
# Picks this machine's build from the GitHub release, checks its SHA-256, and puts it in ~/.capcomd/bin.
#   CAPCOMD_VERSION=0.6.0      a specific version (default: the latest release)
#   CAPCOMD_INSTALL_DIR=DIR    where to put it (default: ~/.capcomd/bin)
#   CAPCOMD_INSTALL_FROM=DIR   install from local files instead of GitHub (capcomd-<os>-<arch> and its .sha256)
# Later: `capcomd upgrade`.
set -eu

REPO=MarvinAmador7/capcomd
die() { echo "capcomd install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "no build for $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "no build for $(uname -m) (x64 and arm64 only)" ;;
esac
# An x64 shell under Rosetta on Apple silicon still gets the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
name="capcomd-$os-$arch"

dir="${CAPCOMD_INSTALL_DIR:-$HOME/.capcomd/bin}"
version="${CAPCOMD_VERSION:-latest}"
version="${version#v}"
if [ -n "${CAPCOMD_INSTALL_FROM:-}" ]; then base="$CAPCOMD_INSTALL_FROM"
elif [ "$version" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/v$version"; fi

fetch() { # url → file
  case "$1" in
    http://* | https://*)
      if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
      else die "needs curl or wget"; fi ;;
    *) cp "$1" "$2" ;;
  esac
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "needs sha256sum or shasum to check the download"; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "Downloading $name ($version) from $base"
fetch "$base/$name" "$tmp/$name" || die "download failed: $base/$name"
fetch "$base/$name.sha256" "$tmp/$name.sha256" || die "download failed: $base/$name.sha256"
want=$(cut -d' ' -f1 < "$tmp/$name.sha256")
got=$(sha256 "$tmp/$name")
[ -n "$want" ] && [ "$want" = "$got" ] || die "checksum mismatch for $name (expected $want, got $got); nothing was installed"

mkdir -p "$dir"
chmod 755 "$tmp/$name"
# Into place atomically: a capcomd that is running keeps its old file.
cp "$tmp/$name" "$dir/.capcomd.$$"
mv -f "$dir/.capcomd.$$" "$dir/capcomd"
echo "Installed $("$dir/capcomd" --version) to $dir/capcomd"

case ":$PATH:" in
  *":$dir:"*) echo "Next: capcomd setup" ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc="~/.zshrc" ;;
      */bash) rc="~/.bashrc" ;;
      */fish) rc="~/.config/fish/config.fish" ;;
      *) rc="your shell's profile" ;;
    esac
    echo ""
    echo "$dir is not on your PATH. Add it (in $rc):"
    case "${SHELL:-}" in
      */fish) echo "  fish_add_path $dir" ;;
      *) echo "  export PATH=\"$dir:\$PATH\"" ;;
    esac
    echo "then run: capcomd setup" ;;
esac
