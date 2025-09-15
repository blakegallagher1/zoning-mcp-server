# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app

# Copy package.json and install deps
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Expose port
EXPOSE 3030

# Default envs (override in Render)
ENV PORT=3030
ENV ALLOW_NO_AUTH=1

# Start
CMD ["node", "server.js"]