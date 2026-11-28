#!/usr/bin/env bash
# Installs a normal (unpatched) Firefox for tests/hero-check.js into ~/.local/jh-ff/env/bin/firefox.
#
# Only needed where `npx playwright install firefox` cannot download (for example the Claude Code
# cloud environment, whose network blocks Playwright's download host). It fetches micromamba and
# Firefox from conda-forge (conda.anaconda.org) instead. Safe to run again; it skips work already done.
# Playwright drives this Firefox over WebDriver BiDi (its `moz-firefox` channel).
#
#   bash tests/install-firefox.sh
#   node tests/hero-check.js
set -euo pipefail
DIR="${JH_FF_DIR:-$HOME/.local/jh-ff}"
mkdir -p "$DIR/bin"
if [ ! -x "$DIR/bin/micromamba" ]; then
  # micromamba is a single static binary, published on conda-forge like any other package
  curl -fsSL https://conda.anaconda.org/conda-forge/linux-64/micromamba-2.10.0-0.tar.bz2 | tar -xj -C "$DIR" bin/micromamba
fi
if [ ! -x "$DIR/env/bin/firefox" ]; then
  "$DIR/bin/micromamba" create -y -q -r "$DIR/mamba" -p "$DIR/env" -c conda-forge firefox
fi
"$DIR/env/bin/firefox" --version
