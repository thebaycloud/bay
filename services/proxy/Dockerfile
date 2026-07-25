FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
