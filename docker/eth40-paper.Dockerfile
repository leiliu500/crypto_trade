FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=UTC ETH40_PORT=3003
COPY package.json package-lock.json ./
COPY node_modules/ws ./node_modules/ws
COPY src/eth40 ./src/eth40
COPY dist/src/eth40 ./dist/src/eth40
COPY src/spot-trend/account.ts src/spot-trend/journal.ts ./src/spot-trend/
COPY dist/src/spot-trend/account.js dist/src/spot-trend/journal.js ./dist/src/spot-trend/
COPY reports/parallel-strategy-study-2026-09-10/data/dataset.json ./reports/parallel-strategy-study-2026-09-10/data/dataset.json
COPY reports/profit-search-100-2026-09-10/forward-experiment.json ./reports/profit-search-100-2026-09-10/forward-experiment.json
COPY reports/profit-search-100-2026-09-10/screen/development-lock.json ./reports/profit-search-100-2026-09-10/screen/development-lock.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3003
CMD ["node", "dist/src/eth40/paper-main.js", "/app/data"]
