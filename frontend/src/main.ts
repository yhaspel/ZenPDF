import { inject, isDevMode, mergeApplicationConfig, provideAppInitializer } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideServiceWorker } from '@angular/service-worker';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { AppUpdateService } from './app/core/services/app-update.service';

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
    provideAppInitializer(() => {
      inject(AppUpdateService);
    }),
  ],
});

bootstrapApplication(App, browserConfig)
  .catch((err) => console.error(err));
