# NoGamble 배포 이미지 (Railway 등). 외부 의존성은 pg 하나뿐이다.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "src/server.ts"]
