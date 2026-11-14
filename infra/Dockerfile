# The Lectern hub image (F§12).
#
# Stage `build` installs the workspace with pnpm, bundles the hub with esbuild and produces the production
# tree with `pnpm deploy`. Stage `piper` is F§2.3's Piper HTTP service and is built only when the compose
# `piper` profile asks for it by name. Stage `runtime` is the hub image, and it is last on purpose: a build
# with no `--target` then produces the hub and never the optional engine.

FROM node:24.22.3-bookworm-slim AS build

# pnpm comes from the base image's own corepack shim, at the version the repository pins in `packageManager`,
# so no package manager is installed globally. The base image ships no curl, which is why the health check in
# the runtime stage is Node's own.
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

WORKDIR /src

# The manifests first: they change far less often than the sources, so the dependency layer is cached across
# rebuilds. Every workspace project's manifest is copied, because the lockfile describes all of them.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/api-client/package.json packages/api-client/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/core/package.json packages/core/
COPY packages/core-tts/package.json packages/core-tts/
COPY packages/fixtures/package.json packages/fixtures/

# `--filter @lectern/server...` installs the hub, the workspace packages it depends on and the root. The other
# applications' toolchains (a browser-test runner, an Electron builder, an Expo SDK) have no business in this
# image and are what would otherwise dominate its size. The two policy flags are per-run and write no file;
# pnpm 12 refuses this lockfile without them, because `@fastify/cors@11.4.3` sits inside its release-age window
# and `tesseract.js` carries a build script.
RUN pnpm install --frozen-lockfile --filter @lectern/server... \
      --config.minimumReleaseAge=0 --config.strictDepBuilds=false \
      --config.store-dir=/tmp/pnpm-store

# Only the sources the bundle reads: never the host's `node_modules`, and never a test tree. `build.mjs` is
# the bundler itself, so it travels beside the sources it reads.
COPY apps/server/build.mjs apps/server/build.mjs
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY packages/api-contract/src packages/api-contract/src
COPY packages/api-contract/tsconfig.json packages/api-contract/tsconfig.json
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/core-tts/src packages/core-tts/src
COPY packages/core-tts/tsconfig.json packages/core-tts/tsconfig.json

# The bundle, then the production tree it runs against. The store is removed in the same layer that filled it:
# the files in both trees are hard links to it, so dropping the store's own directory entries costs no data and
# keeps the intermediate layer small. The installed workspace tree goes too — only `/deploy` and the bundle are
# carried into the runtime stage.
RUN node apps/server/build.mjs \
 && pnpm --filter @lectern/server deploy --prod --config.node-linker=hoisted \
      --config.minimumReleaseAge=0 --config.strictDepBuilds=false \
      --config.store-dir=/tmp/pnpm-store /deploy \
 && rm -rf /tmp/pnpm-store /src/node_modules /src/apps/server/node_modules \
      /src/packages/api-contract/node_modules /src/packages/core/node_modules /src/packages/core-tts/node_modules

# F§2.3's Piper HTTP service, built from `piper-tts[http]` and run as its own module, with one English voice
# downloaded at build time so the container serves a voice list from its first request. Off unless the compose
# `piper` profile is asked for.
FROM python:3.12.13-slim-bookworm AS piper
ENV PIPER_VOICES=/voices
RUN pip install --no-cache-dir "piper-tts[http]==1.8.0" \
 && python3 -m piper.download_voices en_US-lessac-medium --data-dir $PIPER_VOICES
EXPOSE 5000
CMD ["python3", "-m", "piper.http_server", "--host", "0.0.0.0", "--port", "5000", "--data-dir", "/voices", "-m", "/voices/en_US-lessac-medium.onnx"]

# The hub: one bundle, one production `node_modules`, one unprivileged process.
FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV LECTERN_DATA_DIR=/data
ENV LECTERN_PORT=8787
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/package.json ./package.json
COPY --from=build /src/apps/server/dist/server.mjs ./dist/server.mjs

# The data directory is the volume's mount point, and it belongs to the unprivileged user the process runs as.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787

# `/healthz` is the one route F§11 leaves unauthenticated, and the base image has no curl, so the check is
# Node's own. The port is read from the environment so a moved port moves the check with it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.LECTERN_PORT??8787)+'/healthz').then((answer)=>process.exit(answer.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.mjs"]
