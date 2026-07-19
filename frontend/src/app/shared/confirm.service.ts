import { Injectable, signal } from '@angular/core';

interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<ConfirmRequest | null>(null);

  ask(message: string, confirmLabel = 'Confirm'): Promise<boolean> {
    return new Promise((resolve) => {
      this.current.set({ message, confirmLabel, resolve });
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
