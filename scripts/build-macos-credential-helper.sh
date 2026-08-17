#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
package_path="$project_root/macos-helper"
output_dir="$project_root/bin/macos"
arm_scratch="$package_path/.build/arm64"
x86_scratch="$package_path/.build/x86_64"

mkdir -p "$output_dir"

swift build --package-path "$package_path" --configuration release \
  --triple arm64-apple-macosx13.0 --scratch-path "$arm_scratch" \
  --product lovart-credential-helper
swift build --package-path "$package_path" --configuration release \
  --triple x86_64-apple-macosx13.0 --scratch-path "$x86_scratch" \
  --product lovart-credential-helper

arm_bin="$(swift build --package-path "$package_path" --configuration release \
  --triple arm64-apple-macosx13.0 --scratch-path "$arm_scratch" --show-bin-path)"
x86_bin="$(swift build --package-path "$package_path" --configuration release \
  --triple x86_64-apple-macosx13.0 --scratch-path "$x86_scratch" --show-bin-path)"
output="$output_dir/lovart-credential-helper"

xcrun lipo -create \
  "$arm_bin/lovart-credential-helper" \
  "$x86_bin/lovart-credential-helper" \
  -output "$output"
codesign --force --sign - "$output"
chmod 700 "$output"
shasum -a 256 "$output" | awk '{print $1}' > "$output.sha256"
