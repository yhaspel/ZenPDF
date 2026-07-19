import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();
  private counter = 0;

  show(message: string, type: Toast['type'] = 'info'): void {
    const id = (this.counter += 1);
    this._toasts.update((t) => [...t, { id, message, type }]);
    setTimeout(() => this.dismiss(id), 4500);
  }

  success(m: string): void {
    this.show(m, 'success');
  }

  error(m: string): void {
    this.show(m, 'error');
  }

  info(m: string): void {
    this.show(m, 'info');
  }

  dismiss(id: number): void {
    this._toasts.update((t) => t.filter((x) => x.id !== id));
  }
}
