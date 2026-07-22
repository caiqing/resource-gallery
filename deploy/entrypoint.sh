#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/services/api/data}"
mkdir -p "$DATA_DIR/blobs" "$DATA_DIR/uploads"
chown -R node:node "$DATA_DIR"

exec su node -s /bin/sh -c 'exec node dist/index.js'
