FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY config ./config
COPY database ./database
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node config ./config
COPY --chown=node:node database/migrations ./database/migrations
COPY --chown=node:node src/dashboard/public ./dist/src/dashboard/public

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3001

CMD ["node", "--enable-source-maps", "dist/src/main.js"]
