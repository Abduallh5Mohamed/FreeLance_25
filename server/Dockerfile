FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY server/package*.json ./server/
COPY package*.json ./

# Install dependencies
WORKDIR /app/server
RUN npm ci

# Build the project
RUN npm run build

# Start the application
CMD ["npm", "start"]
