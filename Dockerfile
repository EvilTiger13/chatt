# Utgå från en liten officiell Node-image
FROM node:22-alpine

WORKDIR /app

# Installera beroenden först (bättre cache vid ombyggen)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Kopiera resten av koden
COPY . .

# Databas och uppladdade filer sparas här. Montera en volym så att de överlever omstarter.
ENV DATA_DIR=/app/data NODE_ENV=production
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

# Kör inte som root
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "--no-warnings", "server.js"]
