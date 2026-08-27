import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { Job } from '../core/models/models';
import { JobsService } from '../core/services/jobs.service';
import { JobsFacade, TRACK_CEILING_MS } from './jobs.facade';

describe('JobsFacade', () => {
  afterEach(() => vi.useRealTimers());

  it('gives up on a job the worker never returns from, the way the reaper will', () =>
    new Promise<void>((resolve) => {
      vi.useFakeTimers();
      // A job that stays `running` for ever — a MuPDF loop the soft limit
      // cannot interrupt — used to be polled once a second until the reaper
      // failed it, up to thirty-five minutes later.
      const fake: Partial<JobsService> = {
        get: () => of({ id: 'j', status: 'running', progress: 10 } as Job),
      };
      TestBed.configureTestingModule({
        providers: [JobsFacade, { provide: JobsService, useValue: fake }],
      });
      const facade = TestBed.inject(JobsFacade);
      const seen: Job[] = [];
      facade.track('j').subscribe({
        next: (j) => seen.push(j),
        complete: () => {
          const last = seen[seen.length - 1];
          expect(last.status).toBe('failed');
          expect(last.error_code).toBe('timeout');
          expect(last.error_message).toBe('The job stopped responding and was canceled.');
          expect(seen.slice(0, -1).every((j) => j.status === 'running')).toBe(true);
          resolve();
        },
      });
      vi.advanceTimersByTime(TRACK_CEILING_MS + 2000);
    }));

  it('polls a job until it reaches a terminal state', () =>
    new Promise<void>((resolve) => {
      const statuses = ['running', 'succeeded'];
      let i = 0;
      const fake: Partial<JobsService> = {
        get: () => of({ id: 'j', status: statuses[Math.min(i++, statuses.length - 1)], progress: 100 } as Job),
      };
      TestBed.configureTestingModule({
        providers: [JobsFacade, { provide: JobsService, useValue: fake }],
      });
      const facade = TestBed.inject(JobsFacade);
      const seen: string[] = [];
      facade.track('j').subscribe({
        next: (j) => seen.push(j.status),
        complete: () => {
          expect(seen[seen.length - 1]).toBe('succeeded');
          expect(seen.length).toBeGreaterThanOrEqual(2);
          resolve();
        },
      });
    }));
});
