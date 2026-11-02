FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY schema ./schema
COPY config/anycursor.example.json ./config/

RUN useradd --system --uid 10001 --home /app anycursor \
    && chown -R anycursor:anycursor /app

USER anycursor

ENV NODE_ENV=production
EXPOSE 43110

CMD ["node", "src/gateway/index.js", "--config", "/data/config.json"]
