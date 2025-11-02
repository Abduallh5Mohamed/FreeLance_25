FROM node:22-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./
COPY server/package*.json ./server/

# Install root dependencies
RUN npm ci --omit=dev 2>/dev/null || true

# Install server dependencies
WORKDIR /app/server
RUN npm ci

# Build the backend
RUN npm run build

# Set working directory to app root
WORKDIR /app

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server/dist/index.js"]
