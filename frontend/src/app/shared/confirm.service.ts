import { Injectable, signal } from '@angular/core';

interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  /** When set, the user must type this exactly before confirming (phase-07). */
  requireText?: string;
  resolve: (ok: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<ConfirmRequest | null>(null);

  ask(message: string, confirmLabel = 'Confirm', requireText?: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.current.set({ message, confirmLabel, requireText, resolve });
    });
  }

  answer(ok: boolean): void {
    const req = this.current();
    if (req) {
      req.resolve(ok);
      this.current.set(null);
    }
  }
}
