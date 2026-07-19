import { Injectable, inject } from '@angular/core';
import { Observable, switchMap } from 'rxjs';

import { Job } from '../core/models/models';
import { JobsService } from '../core/services/jobs.service';

const TERMINAL = ['succeeded', 'failed', 'canceled'];

@Injectable({ providedIn: 'root' })
export class JobsFacade {
  private jobsSvc = inject(JobsService);

  /** Poll a job (500ms ×6, then 1s) emitting each state until terminal (§7). */
  track(jobId: string): Observable<Job> {
    return new Observable<Job>((subscriber) => {
      let count = 0;
      let handle: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;

      const poll = () => {
        this.jobsSvc.get(jobId).subscribe({
          next: (job) => {
            if (cancelled) return;
            subscriber.next(job);
            if (TERMINAL.includes(job.status)) {
              subscriber.complete();
              return;
            }
            count += 1;
            handle = setTimeout(poll, count < 6 ? 500 : 1000);
          },
          error: (err) => subscriber.error(err),
        });
      };
      poll();

      return () => {
        cancelled = true;
        if (handle) clearTimeout(handle);
      };
    });
  }

  /** Create a job then track it to completion. */
  dispatch(create$: Observable<Job>): Observable<Job> {
    return create$.pipe(switchMap((job) => this.track(job.id)));
  }
}
