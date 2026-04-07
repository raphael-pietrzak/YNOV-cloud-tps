# ============================================
# Stage 1 : Build — Environnement de compilation
# ============================================
FROM node:20-alpine AS build

WORKDIR /app

# Copier les fichiers de dependances
COPY package*.json ./
COPY tsconfig.json ./

# Installer TOUTES les dependances (y compris dev pour compiler TypeScript)
RUN npm install

# Copier le code source TypeScript
COPY src/ ./src/

# Compiler TypeScript -> JavaScript
RUN npm run build

# ============================================
# Stage 2 : Runtime — Image de production minimale
# ============================================
FROM node:20-alpine AS runtime

WORKDIR /app

# Copier uniquement package.json pour installer les dependances de PRODUCTION
COPY package*.json ./
RUN npm install --omit=dev

# Copier uniquement les fichiers compiles depuis le stage "build"
# Syntaxe : COPY --from=[NOM_STAGE] [SOURCE] [DEST]
COPY --from=build /app/dist ./dist

# Utilisateur non-root pour la securite
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 8080
ENV APP_ENV=production
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]