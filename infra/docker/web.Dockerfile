# ZenPDF frontend image. Build context = frontend/.
# dev target: node:24 + ng serve (deps baked into image; source bind-mounted).
# prod target: static build served by nginx.
FROM node:24-slim AS base
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM base AS dev
COPY . .
EXPOSE 4200
CMD ["npm", "start", "--", "--host", "0.0.0.0", "--poll", "2000", "--proxy-config", "proxy.conf.json"]

FROM base AS build
COPY . .
RUN npm run build

FROM nginx:1.29-alpine AS prod
COPY --from=build /app/dist/zenpdf-web/browser /usr/share/nginx/html
COPY ../infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
