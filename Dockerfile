FROM node:22-alpine AS builder

RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3200

COPY --from=builder --chown=node:node /app /app

RUN mkdir -p /app/uploads /app/data/secure-license

EXPOSE 3200

CMD ["npm", "start"]
