FROM oven/bun:1 AS base
WORKDIR /repo

COPY package.json bun.lock* ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN bun install --frozen-lockfile || bun install

COPY packages/db packages/db
COPY packages/jobs packages/jobs
COPY packages/storage packages/storage
COPY apps/worker apps/worker

WORKDIR /repo/apps/worker
CMD ["bun", "run", "start"]
