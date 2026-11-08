FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source code
COPY . .

# Persistent storage for tokens & configurations
VOLUME ["/app/data"]

# Expose proxy port
EXPOSE 18789

ENV HOST=0.0.0.0
ENV PORT=18789
ENV NODE_ENV=production

CMD ["npm", "start"]
