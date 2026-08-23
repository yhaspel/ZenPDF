import { ComponentFixture } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { Job } from '../core/models/models';

/**
 * The one thing every panel that starts a job has to get right.
 *
 * A `JobsFacade.dispatch` observable polls `GET /jobs/:id/` every 500 ms–1 s
 * until the job is terminal, and OCR — the longest-running operation in the
 * product — can poll for minutes. A subscription that is not tied to the
 * component's lifetime keeps polling after the person has gone somewhere else,
 * keeps a destroyed component's closures alive with it, and then calls
 * `toast.error` from a panel nobody is looking at (queue, 2026-08-04).
 *
 * `observed` is rxjs's own answer to "is anyone still listening": it is what
 * `takeUntilDestroyed` flips when the `DestroyRef` fires, so asserting on it
 * tests the operator's actual effect rather than the presence of the word.
 */
export function expectPollEndsWithPanel(
  fixture: ComponentFixture<unknown>,
  poll: Subject<Job>,
  start: () => void,
): void {
  expect(poll.observed).toBe(false);
  start();
  expect(poll.observed).toBe(true);
  // Mid-poll: the job is still running, exactly as OCR would be.
  poll.next({ id: 'job-1', status: 'running' } as Job);
  expect(poll.observed).toBe(true);

  fixture.destroy();

  expect(poll.observed).toBe(false);
}
