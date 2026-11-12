FROM node:24-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

USER node
CMD ["node", "src/server.ts"]
