#!/usr/bin/env bash
# Installs the toolchains Occulta needs into your home directory (no sudo, shell profile untouched):
#   Node.js LTS, Rust 1.91 + wasm32 target, circom, wasm-tools, the Nitro dev-node binary
#   (taken from the official image without Docker) and the PSE powers-of-tau file.
# Afterwards: `source scripts/env.sh` puts them on PATH.
set -euo pipefail

TOOLS="$HOME/.local/share/occulta-tools"
mkdir -p "$HOME/.local/opt" "$HOME/.local/bin" "$TOOLS/ptau"
cd "$(mktemp -d)"

if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  echo "installing Node.js 24 LTS"
  version=$(wget -qO- https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v24.")))')
  wget -q "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" -O node.tar.xz
  rm -rf "$HOME/.local/opt/node" && mkdir -p "$HOME/.local/opt/node"
  tar -xJf node.tar.xz -C "$HOME/.local/opt/node" --strip-components=1
fi

if ! command -v rustup >/dev/null && [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
  echo "installing Rust"
  wget -q https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -O rustup-init
  chmod +x rustup-init && ./rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.91.0
fi
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.local/opt/node/bin:$PATH"
rustup toolchain install 1.91.0 --profile minimal -c rustfmt -c clippy -c rust-src -t wasm32-unknown-unknown

if ! command -v circom >/dev/null; then
  echo "installing circom"
  wget -q https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64 -O "$HOME/.local/bin/circom"
  chmod +x "$HOME/.local/bin/circom"
fi

if ! command -v wasm-tools >/dev/null; then
  echo "installing wasm-tools"
  cargo +stable install --locked wasm-tools@1.260.0 2>/dev/null || { rustup toolchain install stable --profile minimal && cargo +stable install --locked wasm-tools@1.260.0; }
fi

if [[ ! -x "$TOOLS/nitro-rootfs/usr/local/bin/nitro" ]]; then
  echo "installing the Nitro dev-node binary (offchainlabs/nitro-node, no Docker)"
  if ! command -v crane >/dev/null; then
    wget -q https://github.com/google/go-containerregistry/releases/download/v0.20.2/go-containerregistry_Linux_x86_64.tar.gz -O crane.tgz
    tar -xzf crane.tgz -C "$HOME/.local/bin" crane
  fi
  # Only these layers of the pinned image are needed for --dev: the Debian base, its libraries and
  # the nitro binary (it links only libc, libm and libgcc).
  mkdir -p "$TOOLS/nitro-rootfs"
  for digest in \
    dbaa5c62f0ed2acebf15ba5fc565cb938c8495c0b77e1acfab05f5a7354ab1a9 \
    2a0aca2dda1dc9ca29fef3745838fb3d0655911dc0f4bff1aea820c392555f5c \
    04631536f6634c2fab29035250d853a21fef251dc0fa671f3842d522b1c7dbbc \
    8037f35911f3ba1da68d5ee52545b7b6860f1eac3345f5ea2613bb06904cadd4; do
    crane blob "offchainlabs/nitro-node@sha256:$digest" | tar -xz -C "$TOOLS/nitro-rootfs" --exclude='dev/*' 2>/dev/null || true
  done
fi

if [[ ! -f "$TOOLS/ptau/ppot_0080_17.ptau" ]]; then
  echo "downloading the PSE perpetual powers of tau (2^17)"
  wget -q -c https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_17.ptau -O "$TOOLS/ptau/ppot_0080_17.ptau"
fi

echo "tools ready; run: source scripts/env.sh && npm install && npm run setup"
