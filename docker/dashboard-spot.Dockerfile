FROM crypto-trade-engine:spot-dashboard-v7
WORKDIR /app
COPY --chown=node:node dist/src/engine/trading-engine.js dist/src/engine/trading-engine.js.map ./dist/src/engine/
COPY --chown=node:node src/engine/trading-engine.ts ./src/engine/
COPY --chown=node:node src/dashboard/public/ ./dist/src/dashboard/public/
