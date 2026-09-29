FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node server.mjs ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV AI_HUB_HOST=0.0.0.0
ENV AI_HUB_PORT=4179
ENV AI_HUB_DATA_DIR=/data
ENV NODE_OPTIONS=--max-old-space-size=256

EXPOSE 4179

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4179/api/proxy/health',{method:'HEAD'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
ENTRYPOINT ["node", "server.mjs"]
