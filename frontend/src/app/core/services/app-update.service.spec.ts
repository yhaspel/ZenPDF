import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Event, NavigationEnd, Router } from '@angular/router';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';

import { UploadFacade, UploadItem } from '../../abstraction/upload.facade';
import { AppUpdateService } from './app-update.service';

describe('AppUpdateService', () => {
  let versionUpdates: Subject<VersionEvent>;
  let events: Subject<Event>;
  let uploads: ReturnType<typeof signal<UploadItem[]>>;
  let activateUpdate: ReturnType<typeof vi.fn>;
  let checkForUpdate: ReturnType<typeof vi.fn>;

  const ready = (): VersionEvent =>
    ({ type: 'VERSION_READY', currentVersion: { hash: 'a' }, latestVersion: { hash: 'b' } }) as VersionEvent;
  let navId = 0;
  const navigate = (url: string) => events.next(new NavigationEnd(++navId, url, url));
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  function setup(isEnabled = true) {
    TestBed.configureTestingModule({
      providers: [
        { provide: SwUpdate, useValue: { isEnabled, versionUpdates, activateUpdate, checkForUpdate } },
        { provide: Router, useValue: { events } },
        { provide: UploadFacade, useValue: { uploads } },
      ],
    });
    const service = TestBed.inject(AppUpdateService);
    const reload = vi
      .spyOn(service as unknown as { reload: () => void }, 'reload')
      .mockImplementation(() => undefined);
    return { service, reload };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
    versionUpdates = new Subject<VersionEvent>();
    events = new Subject<Event>();
    uploads = signal<UploadItem[]>([]);
    activateUpdate = vi.fn().mockResolvedValue(true);
    checkForUpdate = vi.fn().mockResolvedValue(false);
  });

  afterEach(() => vi.useRealTimers());

  it('wires nothing when the service worker is disabled', () => {
    setup(false);
    expect(versionUpdates.observed).toBe(false);
    expect(events.observed).toBe(false);
  });

  it('does nothing on navigation when no update is ready', async () => {
    const { reload } = setup();
    navigate('/merge-pdf');
    await flush();
    expect(activateUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores version events other than VERSION_READY', async () => {
    const { reload } = setup();
    versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } } as VersionEvent);
    versionUpdates.next({ type: 'NO_NEW_VERSION_DETECTED', version: { hash: 'a' } } as VersionEvent);
    versionUpdates.next({
      type: 'VERSION_INSTALLATION_FAILED',
      version: { hash: 'b' },
      error: 'x',
    } as VersionEvent);
    navigate('/merge-pdf');
    await flush();
    expect(activateUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    '/app/doc/d1',
    '/app/doc/d1?mode=annotate',
    '/app/doc/d1#page=3',
    '/app/doc/d1/',
    '/app/sign/new/d1',
    '/s/tok123',
  ])('does not reload on arriving at %s', async (url) => {
    const { reload } = setup();
    versionUpdates.next(ready());
    navigate(url);
    await flush();
    expect(activateUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload while hopping between unsafe routes', async () => {
    const { reload } = setup();
    versionUpdates.next(ready());
    navigate('/app/doc/d1');
    navigate('/app/doc/d1?mode=edit');
    navigate('/app/doc/d2');
    navigate('/app/sign/new/d2');
    await flush();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(['/app/sign/r1', '/settings', '/app/settings', '/app/dashboard', '/'])(
    'treats %s as safe',
    async (url) => {
      const { reload } = setup();
      versionUpdates.next(ready());
      navigate(url);
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );

  it('activates and reloads once at the next safe navigation, and not again', async () => {
    const { reload } = setup();
    versionUpdates.next(ready());
    navigate('/app/doc/d1');
    await flush();
    expect(reload).not.toHaveBeenCalled();

    navigate('/app/dashboard');
    await flush();
    expect(activateUpdate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);

    navigate('/merge-pdf');
    navigate('/about');
    await flush();
    expect(activateUpdate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when activation fails', async () => {
    activateUpdate.mockRejectedValue(new Error('broken'));
    const { reload } = setup();
    versionUpdates.next(ready());
    navigate('/about');
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits for dashboard uploads to finish before reloading', async () => {
    const file = new File([new Uint8Array([1])], 'x.pdf');
    uploads.set([{ id: 'u1', name: 'x.pdf', progress: 40, status: 'uploading', file }]);
    const { reload } = setup();
    versionUpdates.next(ready());
    navigate('/app/settings');
    await flush();
    expect(reload).not.toHaveBeenCalled();

    uploads.set([{ id: 'u1', name: 'x.pdf', progress: 100, status: 'done', file }]);
    navigate('/app/dashboard');
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('asks the worker for a new version at most every fifteen minutes', () => {
    setup();
    navigate('/merge-pdf');
    expect(checkForUpdate).not.toHaveBeenCalled(); // the page load just checked

    vi.setSystemTime(new Date('2026-09-26T12:15:00Z'));
    navigate('/split-pdf');
    navigate('/about');
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-26T12:29:00Z'));
    navigate('/merge-pdf');
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-26T12:30:00Z'));
    navigate('/merge-pdf');
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed check (offline) and does not check once an update is ready', async () => {
    checkForUpdate.mockRejectedValue(new Error('offline'));
    const { reload } = setup();
    vi.setSystemTime(new Date('2026-09-26T13:00:00Z'));
    navigate('/app/doc/d1');
    await flush();
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    versionUpdates.next(ready());
    vi.setSystemTime(new Date('2026-09-26T14:00:00Z'));
    navigate('/app/doc/d1?mode=edit');
    await flush();
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});
