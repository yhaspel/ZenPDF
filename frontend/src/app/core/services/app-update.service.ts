import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';

import { UploadFacade } from '../../abstraction/upload.facade';

/**
 * Where a reload would destroy work in progress: the workspace (an open edit,
 * annotations not yet saved), the request builder (placed fields) and the
 * signing ceremony (a drawn signature, a ticked consent). The workspace also
 * navigates *within* itself (`?mode=`), so a NavigationEnd there is not a
 * moment between pages.
 */
const UNSAFE_URL = /^\/(?:app\/doc|app\/sign\/new|s)\/[^/]+/;

/**
 * How often, at most, a navigation asks the worker to look for a new version.
 * The worker looks by itself only on a full page load or when it restarts, and
 * an app tab can go days with neither.
 */
const CHECK_EVERY_MS = 15 * 60_000;

/**
 * Picks up a new deploy at the next safe navigation instead of prompting.
 *
 * By default the service worker downloads a new build in the background and
 * leaves the open tab on the old one until a full page load, which a tab kept
 * open for days never gets. This reloads at the next navigation to a page
 * where nothing is in progress: a navigation already discards the page being
 * left, so the reload costs the visitor nothing they had.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly router = inject(Router);
  private readonly uploads = inject(UploadFacade);
  private readonly document = inject(DOCUMENT);
  private updateReady = false;
  // The page load that constructed this service was itself a check.
  private lastCheck = Date.now();

  constructor() {
    if (!this.swUpdate.isEnabled) return; // dev builds, browsers without SW: nothing to wire
    this.swUpdate.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => (this.updateReady = true));
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.onNavigated(e.urlAfterRedirects.split(/[?#]/)[0]));
  }

  private onNavigated(path: string): void {
    if (!this.updateReady) {
      this.checkIfDue();
      return;
    }
    // Dashboard uploads live in a root facade and outlive the page that
    // started them, so a reload would cut them off wherever the visitor went.
    const uploading = this.uploads.uploads().some((u) => u.status === 'uploading');
    if (UNSAFE_URL.test(path) || uploading) return;
    this.updateReady = false;
    // Reload even if activation fails: a page load gets the newest version anyway.
    const reload = () => this.reload();
    this.swUpdate.activateUpdate().then(reload, reload);
  }

  private checkIfDue(): void {
    if (Date.now() - this.lastCheck < CHECK_EVERY_MS) return;
    this.lastCheck = Date.now();
    // Offline is not an error worth reporting; the next due check tries again.
    this.swUpdate.checkForUpdate().catch(() => undefined);
  }

  /** Separate method so specs can stub it — `location.reload` can't be spied on. */
  protected reload(): void {
    this.document.location.reload();
  }
}
