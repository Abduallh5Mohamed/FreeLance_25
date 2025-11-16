FROM node:22-alpine

WORKDIR /app

# Copy package files from root and server
COPY ../package*.json ./
COPY package*.json ./

# Install root dependencies (optional)
WORKDIR /app
RUN npm ci 2>/dev/null || true

# Install server dependencies
WORKDIR /app/server
COPY . .
RUN npm ci

# Build TypeScript
RUN npm run build

# Switch back to app root for running
WORKDIR /app

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server/dist/index.js"]

