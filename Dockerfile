# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app

# Install deps
COPY package.json package-lock.json* .npmrc* ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Expose port
EXPOSE 3030

# Healthcheck (container-level)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3030/health || exit 1

# Default envs (override in Render)
ENV PORT=3030
# Keep unauth for ChatGPT connector compatibility unless you enable API Key auth there.
ENV ALLOW_NO_AUTH=1

# Start
CMD ["node", "server.js"]
