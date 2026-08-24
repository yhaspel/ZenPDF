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
    //
    // **This is also why fourteen `router.navigate(…)` calls are spelled
    // `void`** (2026-08-24, when `no-floating-promises` first ran over this
    // tree). A navigation nothing waits on can still *reject* — a guard that
    // throws, or a lazy chunk that 404s because the app was redeployed under
    // an open tab — and `void` leaves that rejection unhandled **on purpose**,
    // so the `unhandledrejection` listener above hands it to
    // `ClientErrorHandler` and it arrives in the same log as every other
    // crash. Attaching a `.catch()` at those sites would be the change that
    // loses it: a caught rejection never fires the event. Verified in
    // `@angular/core`, not assumed — the listener is `e => { errorHandler
    // (e.reason); e.preventDefault(); }`.
    { provide: ErrorHandler, useClass: ClientErrorHandler },
    // Tool pages take their definition from the route table via `data` (§21.6).
    provideRouter(routes, withComponentInputBinding()),
    // withFetch is required for HttpClient to work under server-side rendering.
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
  ],
};
