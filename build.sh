#!/usr/bin/env bash
# Builds all three sites (landing, docs, blog) and assembles them into _site/.
# Used by Cloudflare Pages and runnable locally.
set -euo pipefail

# 1. Install + build VitePress docs
( cd docs && npm ci && npm run build )

# 2. Install + build Astro blog
( cd blog && npm ci && npm run build )

# 3. Assemble _site/
rm -rf _site
mkdir -p _site/docs _site/blog
cp website/index.html website/styles.css website/app.js website/transparent-logo.svg _site/
cp -r docs/.vitepress/dist/* _site/docs/
cp -r blog/dist/* _site/blog/

# 4. Copy security headers (optional, picked up by Cloudflare Pages)
if [ -f _headers ]; then
  cp _headers _site/_headers
fi

echo "Site assembled at _site/"
