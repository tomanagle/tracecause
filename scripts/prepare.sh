#!/usr/bin/env sh

set -eu

if [ "${CI:-}" = "true" ]; then
  exit 0
fi

./scripts/prepare-effect.sh
lefthook install
