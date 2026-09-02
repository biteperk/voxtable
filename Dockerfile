# ---- Stage 1: Builder ----
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY apps/kds/package.json ./apps/kds/package.json

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy all source code
COPY . .

# Build the backend (TypeScript -> JavaScript).
# Raise the V8 heap for tsc: the production VM is memory-constrained (~1GB RAM)
# and the default old-space limit OOMs (SIGABRT) while compiling the full
# backend. This only affects the throwaway builder stage, not the runtime image.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN npm run build:backend

# ---- Stage 2: Runner ----
FROM node:24-alpine AS runner

WORKDIR /app

# Install wget for healthcheck (usually present in alpine, but ensure it)
RUN apk add --no-cache wget

# Copy package files
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY apps/kds/package.json ./apps/kds/package.json

# Install production dependencies only
RUN npm ci --workspace=@voxtable/backend --omit=dev --omit=optional && \
    npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy compiled backend output
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist

# Copy migration files needed at runtime
COPY --from=builder /app/apps/backend/db ./apps/backend/db

# Create non-root user and group
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Switch to non-root user
USER appuser

# Expose application port
EXPOSE 3050

# Healthcheck using wget (curl not available by default on alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3050/health || exit 1

# Start the backend server
CMD ["node", "apps/backend/dist/server.js"]
