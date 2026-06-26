# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js eslint.config.js ./
COPY src ./src
# Production: same-origin /api через nginx
ENV VITE_API_BASE=
RUN npm run build

FROM node:22-bookworm-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
COPY scripts ./scripts
COPY db ./db
COPY --from=frontend-build /app/dist ./dist
ENV NODE_ENV=production
WORKDIR /app/server
EXPOSE 3001
CMD ["node", "index.js"]
