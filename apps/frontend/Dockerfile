# Build-Context = Repo-Root. Stage 1: Angular mit NX bauen
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json nx.json tsconfig.base.json tsconfig.json ./
COPY apps/frontend ./apps/frontend
COPY libs ./libs
RUN npm ci
RUN npx nx build frontend

# Stage 2: nginx liefert statische Files + Reverse-Proxy zum Backend
FROM nginx:alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/dist/apps/frontend/browser /usr/share/nginx/html
EXPOSE 80
