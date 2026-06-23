# Build context = repo root (needs libs/ + workspace config).
# Stage 1: build the backend with NX
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json nx.json tsconfig.base.json tsconfig.json ./
# Whole apps folder so the tsconfig reference graph is complete
# (otherwise the NX sync check fails in a non-interactive build).
COPY apps ./apps
COPY libs ./libs
RUN npm ci
RUN npx nx build backend
# Install runtime dependencies into the bundle directory (generatePackageJson)
RUN cd apps/backend/dist && npm install --omit=dev

# Stage 2: slim runtime image (runs as the non-root user 'node')
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build --chown=node:node /repo/apps/backend/dist ./
USER node
EXPOSE 3000
CMD ["node", "main.js"]
