#!/usr/bin/env bash
# Build script for PledgeStack native Rust addons.
# Compiles all Rust crates in native/ into .node files.
#
# Usage:
#   ./build-native.sh           # Build all addons
#   ./build-native.sh --release # Build with optimizations
#   ./build-native.sh --check   # Type-check only (cargo check)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/native"
PROFILE="dev"

while [[ $# -gt 0 ]]; do
  case $1 in
    --release)
      PROFILE="release"
      shift
      ;;
    --check)
      echo "Checking Rust addons..."
      (cd "$NATIVE_DIR" && cargo check --workspace)
      exit $?
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "Building PledgeStack native addons ($PROFILE)..."

CRATES=(
  "rust-html"
  "rust-ssr"
  "rust-rsc"
  "rust-html-transformer"
  "rust-dom-renderer"
  "rust-rsc-deserializer"
  "rust-ssr-profiler"
  "rust-hydration"
  "rust-og-renderer"
  "rust-kv-store"
  "rust-rate-limiter"
  "rust-static-server"
  "rust-compression"
  "rust-search"
  "rust-jit-templates"
  "rust-ws-compression"
)

for crate in "${CRATES[@]}"; do
  echo "  Building $crate..."
  (cd "$NATIVE_DIR/$crate" && cargo build --profile $PROFILE)

  # Copy the .node file to the expected location
  BUILT_FILE=$(find "$NATIVE_DIR/target/$PROFILE" -name "lib${crate//-/_}*.so" -o -name "${crate//-/_}*.dll" -o -name "lib${crate//-/_}*.dylib" | head -1)
  if [ -z "$BUILT_FILE" ]; then
    # Try cdylib naming
    BUILT_FILE=$(find "$NATIVE_DIR/target/$PROFILE" -name "*.so" -o -name "*.dll" -o -name "*.dylib" | grep -i "${crate//-/_}" | head -1)
  fi

  if [ -n "$BUILT_FILE" ]; then
    cp "$BUILT_FILE" "$NATIVE_DIR/${crate}.node"
    echo "    → $NATIVE_DIR/${crate}.node"
  else
    echo "    WARNING: Could not find built .node file for $crate"
  fi
done

echo "Done! Native addons built successfully."
