FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=UTC
COPY package.json package-lock.json tsconfig.json ./
COPY dist/src/spot-trend ./dist/src/spot-trend
COPY src/spot-trend ./src/spot-trend
COPY reports/new-spot-system-2026-09-10 ./reports/new-spot-system-2026-09-10
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3002
CMD ["node", "dist/src/spot-trend/paper-main.js", "reports/new-spot-system-2026-09-10/historical-study", "reports/new-spot-system-2026-09-10/audit.json", "/app/data", "--serve"]
