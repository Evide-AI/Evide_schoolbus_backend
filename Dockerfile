# Node backend for GT06 ingestion + API + workers.
FROM node:22-slim

WORKDIR /app

# Install deps first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source.
COPY src ./src

# GT06 TCP port + HTTP API port (both proxied/exposed per docker-compose).
EXPOSE 5023 3000

CMD ["node", "src/server.js"]
