import { Injectable, inject } from '@angular/core';
import { Observable, switchMap } from 'rxjs';

import { Job } from '../core/models/models';
import { JobsService } from '../core/services/jobs.service';

const TERMINAL = ['succeeded', 'failed', 'canceled'];

/**
 * How long a job is followed before the client stops believing in it.
 *
 * The worker's hard time limit is 900 s (`CELERY_TASK_TIME_LIMIT`): past it
 * the process is killed, and a job whose worker was killed keeps its
 * `running` row until `reap_stalled_jobs` fails it, up to thirty-five
 * minutes later. A save that MuPDF never returned from (2026-08-26 queue
 * row) was polled once a second for that whole time, with Save and Flatten
 * disabled over unsaved work. So the client gives a job the worker's limit
 * plus a minute, and then reports it the way the reaper will.
 */
export const TRACK_CEILING_MS = 16 * 60_000;

/** The reaper's own sentence, so the two ways of giving up read the same. */
const TIMEOUT_MESSAGE = 'The job stopped responding and was canceled.';

@Injectable({ providedIn: 'root' })
export class JobsFacade {
  private jobsSvc = inject(JobsService);

  /** Poll a job (500ms ×6, then 1s) emitting each state until terminal (§7). */
  track(jobId: string): Observable<Job> {
    return new Observable<Job>((subscriber) => {
      let count = 0;
      let handle: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;

      const startedAt = Date.now();

      const poll = () => {
        this.jobsSvc.get(jobId).subscribe({
          next: (job) => {
            if (cancelled) return;
            if (!TERMINAL.includes(job.status) && Date.now() - startedAt >= TRACK_CEILING_MS) {
              // Reported as the failure the reaper will record, not thrown:
              // every panel already turns a failed job into a toast and
              // releases its `busy()`, and this is exactly that case.
              subscriber.next({
                ...job,
                status: 'failed',
                error_code: 'timeout',
                error_message: TIMEOUT_MESSAGE,
              });
              subscriber.complete();
              return;
            }
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
