FROM node:lts-alpine
WORKDIR /app 
RUN apk add --no-cache bash
RUN npm install -g pm2
COPY [ "package.json", "yarn.lock", "tsconfig.json", "./" ]
RUN npm install
COPY . ./ 
CMD [ "pm2-runtime", "ecosystem.config.js"]
