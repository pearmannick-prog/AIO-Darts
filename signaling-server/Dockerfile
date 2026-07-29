# Granboard online-challenge signaling server.
# Small Alpine-based image - this server does almost nothing (see server.js),
# so there's no need for anything heavier.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

EXPOSE 8080

CMD ["node", "server.js"]
