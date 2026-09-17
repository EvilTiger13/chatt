# Utgå från en liten officiell Node-image
FROM node:22-alpine

WORKDIR /app

# Installera beroenden först (bättre cache vid ombyggen)
COPY package*.json ./
RUN npm install --omit=dev

# Kopiera resten av koden
COPY . .

# Databasen sparas här. Montera en volym så att den överlever omstarter.
ENV DB_PATH=/app/data/chatt.db
VOLUME /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "--no-warnings", "server.js"]
