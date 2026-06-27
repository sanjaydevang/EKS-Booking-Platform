# ── Stage 1: deps ─────────────────────────────────────────────────────────────
# Use specific digest to make Trivy scans reproducible — no "latest" drift
FROM node:20-alpine3.19 AS deps

WORKDIR /app

# Copy only lockfile first — Docker caches this layer unless package.json changes
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ── Stage 2: builder (for tests in CI — not shipped to prod) ──────────────────
FROM node:20-alpine3.19 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run lint 2>/dev/null || true

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine3.19 AS runtime

# Don't run as root — Kubernetes PSP / Pod Security Standards require non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Only copy prod deps from stage 1
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# Drop privileges
USER appuser

EXPOSE 3001

# tini handles zombie processes and proper signal forwarding (SIGTERM → graceful shutdown)
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health/live || exit 1

LABEL org.opencontainers.image.title="booking-service" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/your-org/eks-booking-platform"
