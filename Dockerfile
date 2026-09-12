FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/client/package.json packages/client/package.json
RUN npm ci
COPY apps apps
COPY packages packages
RUN npm run build

FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4300
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server ./apps/server
USER node
EXPOSE 4300
CMD ["node", "apps/server/dist/index.js"]

FROM nginx:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
