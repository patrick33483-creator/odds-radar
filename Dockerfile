FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Do not recursively chown production node_modules on every deploy: that
# creates an enormous image layer and can leave a small production host stuck
# unpacking the image before the service is restarted. Only writable mounts
# need ownership; application code is safely readable by the non-root user.
RUN mkdir -p /app/data /app/backups \
    && chown node:node /app/data /app/backups
COPY --from=build /app/dist ./dist
USER node

EXPOSE 5000
CMD ["node", "dist/index.cjs"]
