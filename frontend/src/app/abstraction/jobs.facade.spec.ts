import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { Job } from '../core/models/models';
import { JobsService } from '../core/services/jobs.service';
import { JobsFacade } from './jobs.facade';

describe('JobsFacade', () => {
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
