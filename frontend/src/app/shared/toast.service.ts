import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

/** How long a toast stays. Errors linger, because "it failed" is a sentence
 *  somebody has to read and act on; a success is a receipt (§10.3). */
const DEFAULT_MS = 4500;
const ERROR_MS = 9000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();
  private counter = 0;

  show(message: string, type: Toast['type'] = 'info', ms?: number): void {
    const id = (this.counter += 1);
    this._toasts.update((t) => [...t, { id, message, type }]);
    setTimeout(
      () => this.dismiss(id),
      ms ?? (type === 'error' ? ERROR_MS : DEFAULT_MS),
    );
  }

  success(m: string, ms?: number): void {
    this.show(m, 'success', ms);
  }

  error(m: string, ms?: number): void {
    this.show(m, 'error', ms);
  }

  info(m: string, ms?: number): void {
    this.show(m, 'info', ms);
  }

  dismiss(id: number): void {
    this._toasts.update((t) => t.filter((x) => x.id !== id));
  }
}
