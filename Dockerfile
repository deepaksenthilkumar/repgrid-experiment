FROM node:20-alpine

# Install build tools for native dependencies (better-sqlite3, bcrypt)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/

RUN npm run build

# Create data directory
RUN mkdir -p data/results data/analysis

EXPOSE 3001

CMD ["node", "dist/server.js"]
