# Build context = repo root. Stage 1: build Angular with NX
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json nx.json tsconfig.base.json tsconfig.json ./
COPY apps/frontend ./apps/frontend
COPY libs ./libs
RUN npm ci
RUN npx nx build frontend

# Stage 2: nginx (unprivileged = non-root, listens on 8080) serves the
# static files + reverse-proxies to the backend
FROM nginxinc/nginx-unprivileged:alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/dist/apps/frontend/browser /usr/share/nginx/html
EXPOSE 8080
