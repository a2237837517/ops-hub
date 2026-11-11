FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache zip unzip tar gzip

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js config.example.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 7100
CMD ["node", "index.js", "serve"]
