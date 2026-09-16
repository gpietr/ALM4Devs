# One-shot migration runner: `docker compose --profile migrate run --rm migrate`
# Built from the repo root so bun workspaces resolve correctly.
FROM oven/bun:1 AS base
WORKDIR /repo

COPY package.json bun.lock* ./
COPY packages/db/package.json packages/db/package.json
RUN bun install --frozen-lockfile || bun install

COPY packages/db packages/db

WORKDIR /repo/packages/db
CMD ["bun", "run", "migrate"]
