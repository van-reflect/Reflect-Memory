FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
COPY schema.sql ./schema.sql
COPY openapi-agent.yaml ./openapi-agent.yaml
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/schema.sql ./schema.sql
COPY --from=build /app/openapi-agent.yaml ./openapi-agent.yaml
RUN mkdir -p /data && \
    addgroup --system appgroup && \
    adduser --system --ingroup appgroup appuser && \
    chown -R appuser:appgroup /app /data
USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
