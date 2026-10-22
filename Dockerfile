# The Redline as a container: Railway, Render, Fly, Coolify, or any machine that runs Docker.
#   docker build -t redline .
#   docker run -p 4848:4848 -v redline-data:/data -e REDLINE_PUBLISH_KEY=... -e REDLINE_DASHBOARD_TOKEN=... redline
# Data goes in /data (SQLite and files) unless DATABASE_URL points at a Postgres database.
FROM node:24-slim

WORKDIR /app/site
COPY site/package.json site/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY site/ ./

# Hosts mount their volumes as root, so the server runs as root inside the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4848 \
    REDLINE_DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data
EXPOSE 4848

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/robots.txt').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node/server.mjs"]
