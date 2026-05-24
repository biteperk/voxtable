# ---- Stage 1: Builder ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy all source code
COPY . .

# Build the backend (TypeScript -> JavaScript)
RUN npm run build:backend

# ---- Stage 2: Runner ----
FROM node:20-alpine AS runner

WORKDIR /app

# Install wget for healthcheck (usually present in alpine, but ensure it)
RUN apk add --no-cache wget

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled backend output
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist

# Copy migration and seed files needed at runtime
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
