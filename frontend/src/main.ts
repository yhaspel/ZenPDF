import { isDevMode, mergeApplicationConfig } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideServiceWorker } from '@angular/service-worker';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Browser-only providers. `appConfig` is shared with the prerenderer
// (app.config.server.ts merges it), where there is no navigator.serviceWorker,
// so these are added here — the one file the prerenderer never loads.
// `zen-sw.js` is Angular's worker with /api and other origins taken out of its
// hands; see the file itself.
const browserConfig = mergeApplicationConfig(appConfig, {
  providers: [
    provideServiceWorker('zen-sw.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
});

bootstrapApplication(App, browserConfig)
  .catch((err) => console.error(err));
