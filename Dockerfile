FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json eslint.config.mjs ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/overlay/public ./src/overlay/public
COPY --from=build /app/src/setup/public ./src/setup/public

# Mount /app/data as a volume to persist tokens, SQLite db, and CSV.
VOLUME ["/app/data"]

EXPOSE 4488

CMD ["node", "dist/src/index.js"]
