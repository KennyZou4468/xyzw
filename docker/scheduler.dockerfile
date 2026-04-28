ARG PLAYWRIGHT_BASE_IMAGE=mcr.microsoft.com/playwright:v1.59.1-noble
FROM ${PLAYWRIGHT_BASE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY src ./src
COPY worker.js ./worker.js

RUN mkdir -p /app/runtime

EXPOSE 8090

CMD ["node", "server/backgroundScheduler.js", "--tasks", "/app/runtime/scheduler.tasks.json", "--log", "/app/runtime/scheduler.log", "--ui-logs", "/app/runtime/scheduler.ui.logs.json", "--lock", "/app/runtime/scheduler.lock", "--api-port", "8090"]
