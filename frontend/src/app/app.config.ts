import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Tool pages take their definition from the route table via `data` (§21.6).
    provideRouter(routes, withComponentInputBinding()),
    // withFetch is required for HttpClient to work under server-side rendering.
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
  ],
};
