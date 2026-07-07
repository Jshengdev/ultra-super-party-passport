#!/usr/bin/env bash
# Static-export deploy to Butterbase Pages. The POST-only checkin route cannot be
# statically exported; it steps aside for the export build and returns after.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .export-aside
mv app/api/checkin .export-aside/checkin
trap 'mv .export-aside/checkin app/api/checkin; rmdir .export-aside' EXIT
STATIC_EXPORT=1 npx next build
cd out && zip -qr ../frontend.zip . && cd ..
echo "frontend.zip: $(du -h frontend.zip | cut -f1)"
