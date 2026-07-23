FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/data /app/data/users

EXPOSE 3005

CMD ["node", "server/index.js"]
