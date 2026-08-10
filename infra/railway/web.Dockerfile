# ZenPDF web image for Railway. Build context = repo root.
FROM node:24-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

FROM nginx:1.29-alpine
COPY --from=build /app/dist/zenpdf-web/browser /usr/share/nginx/html
COPY infra/railway/nginx.railway.conf /etc/nginx/conf.d/default.conf
# `railway up` uploads the working tree with its real modes, and Angular copies
# `public/` into the bundle verbatim — so a developer whose umask left the fonts
# at 0600 ships an image whose worker cannot read them, and every webfont and
# favicon 403s while the HTML still returns 200. That shipped once. This makes
# the served tree readable no matter what the uploader's modes were.
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
