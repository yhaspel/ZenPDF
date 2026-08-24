import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';

import { environment } from '../../../environments/environment';
import { apiError } from '../api-error';

/**
 * "Send me the link again" (§9B).
 *
 * One place, because the verification gate is reachable from two very
 * different screens — the settings banner, and the moment somebody presses
 * Send on a signature request and is refused. The second is the one that
 * matters: a refusal with no way forward on the screen where it happens is a
 * dead end, and the person has usually not seen a settings page at all.
 */
@Injectable({ providedIn: 'root' })
export class VerificationService {
  private http = inject(HttpClient);

  readonly sending = signal(false);
  readonly sent = signal(false);
  readonly failure = signal('');

  resend(): void {
    if (this.sending()) return;
    this.sending.set(true);
    this.failure.set('');
    this.http.post(`${environment.apiUrl}/users/verify/send/`, {}).subscribe({
      next: () => {
        this.sending.set(false);
        this.sent.set(true);
      },
      error: (err) => {
        this.sending.set(false);
        // A cooldown is the expected answer, not a fault — the endpoint mails
        // an address nobody has proved they own, so it is deliberately capped.
        this.failure.set(
          apiError(err).message || 'Could not send that just now.',
        );
      },
    });
  }
}

/** Whether an API error is the verification gate (§9B), from the code rather
 *  than the message — the copy is allowed to change. */
export function isEmailNotVerified(err: unknown): boolean {
  return apiError(err).code === 'email_not_verified';
}
