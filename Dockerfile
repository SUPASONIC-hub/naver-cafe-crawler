FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
