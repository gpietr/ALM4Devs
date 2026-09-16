# Deliberately self-hosting Next.js under `bun run start`, not Vercel - this is the
# specific Bun-in-prod risk flagged in TECH_STACK.md, and exactly what this walking
# skeleton exists to shake out before real feature work begins.
FROM oven/bun:1 AS base
WORKDIR /repo

# wkhtmltopdf (backlog item 9.29's PDF engine - see packages/documents' docstring for why
# this over a headless browser): not in Debian's own apt repos (dropped in recent
# releases), so installed from the official wkhtmltopdf/packaging release build instead -
# a statically-linked package (its own Qt/WebKit bundled in, not the system's), confirmed
# directly against this exact base image to install and actually convert HTML to a real
# PDF, not just assumed to work. libjpeg62-turbo is the one runtime dependency that
# release build doesn't bundle itself; the rest (fontconfig, libxrender1, libxext6,
# xfonts) are what its offscreen renderer needs to lay out text and tables without a
# display.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      wget ca-certificates fontconfig libxrender1 libxext6 xfonts-75dpi xfonts-base && \
    wget -q -O /tmp/wkhtmltox.deb \
      https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.bookworm_amd64.deb && \
    apt-get install -y -qq /tmp/wkhtmltox.deb && \
    rm -rf /tmp/wkhtmltox.deb /var/lib/apt/lists/*

COPY package.json bun.lock* tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/integrations/spira/package.json packages/integrations/spira/package.json
RUN bun install --frozen-lockfile || bun install

COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/documents packages/documents
COPY packages/jobs packages/jobs
COPY packages/storage packages/storage
COPY packages/integrations/spira packages/integrations/spira
COPY apps/web apps/web

WORKDIR /repo/apps/web
RUN bun run build

EXPOSE 3000
CMD ["bun", "run", "start"]
