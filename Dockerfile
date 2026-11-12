FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY server.js index.html sw.js manifest.webmanifest icon.svg icon-192.png icon-512.png fs-seed.json ./
ENV NODE_ENV=production
# Cloud Run ustawia PORT (domyslnie 8080); server.js go czyta
CMD ["node", "server.js"]
