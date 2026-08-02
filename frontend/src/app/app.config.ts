import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { ClientErrorHandler } from './core/client-errors';
import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Those listeners route `window.onerror` and `unhandledrejection` to the
    // ErrorHandler; without one of our own they reach the console and stop
    // there, which is where every client-side crash has gone until now.
    { provide: ErrorHandler, useClass: ClientErrorHandler },
    // Tool pages take their definition from the route table via `data` (§21.6).
    provideRouter(routes, withComponentInputBinding()),
    // withFetch is required for HttpClient to work under server-side rendering.
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
  ],
};
