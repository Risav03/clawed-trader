# ── Build stage ──────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production stage ────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Create data directory for persistent state
RUN mkdir -p /app/dist/data

# Non-root user for security
RUN addgroup --system --gid 1001 openclaw && \
    adduser --system --uid 1001 --gid 1001 openclaw && \
    chown -R openclaw:openclaw /app

USER openclaw

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
