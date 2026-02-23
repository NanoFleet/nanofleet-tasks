FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json ./
RUN bun install --frozen-lockfile

COPY . .

RUN mkdir -p /data /shared

ENV NODE_ENV=production

EXPOSE 8820 8821

CMD ["bun", "run", "src/index.ts"]
