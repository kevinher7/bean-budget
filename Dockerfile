FROM node:22.23.4-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/budget/package.json packages/budget/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace=@bean-budget/server --include-workspace-root --no-audit --no-fund \
    && npm cache clean --force

COPY apps/server/ apps/server/
COPY packages/budget/ packages/budget/
COPY packages/protocol/ packages/protocol/
RUN mkdir /data && chown node:node /data

USER node
ENV BEAN_HOST=0.0.0.0 BEAN_PORT=3000 BEAN_DATABASE=/data/bean-budget.sqlite
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
