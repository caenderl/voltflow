# Build-Context = Repo-Root (braucht libs/ + Workspace-Konfig).
# Stage 1: Backend mit NX bauen
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json nx.json tsconfig.base.json tsconfig.json ./
# Ganzer apps-Ordner, damit der tsconfig-Referenzgraph vollständig ist
# (sonst bricht der NX-Sync-Check im nicht-interaktiven Build ab).
COPY apps ./apps
COPY libs ./libs
RUN npm ci
RUN npx nx build backend
# Laufzeit-Abhängigkeiten ins Bundle-Verzeichnis installieren (generatePackageJson)
RUN cd apps/backend/dist && npm install --omit=dev

# Stage 2: schlankes Runtime-Image
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /repo/apps/backend/dist ./
EXPOSE 3000
CMD ["node", "main.js"]
