// Relative /api → dev: ng serve proxy.conf routes to api:8000; prod: nginx proxies.
export const environment = {
  production: false,
  apiUrl: '/api',
};
