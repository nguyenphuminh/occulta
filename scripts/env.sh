#!/usr/bin/env bash
# Puts the locally installed toolchains (see scripts/setup-tools.sh) on PATH.
# Usage: source scripts/env.sh
export PATH="$HOME/.local/opt/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
