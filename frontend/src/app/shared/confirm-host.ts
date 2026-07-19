import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ConfirmService } from './confirm.service';

@Component({
  selector: 'app-confirm-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (confirm.current(); as req) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-test="confirm-host">
        <div class="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
          <p class="mb-6 text-slate-700">{{ req.message }}</p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-slate-600 hover:bg-slate-100"
              (click)="confirm.answer(false)"
              data-test="confirm-cancel"
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-rose-600 px-4 py-2 text-white hover:bg-rose-700"
              (click)="confirm.answer(true)"
              data-test="confirm-ok"
            >
              {{ req.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmHost {
  protected confirm = inject(ConfirmService);
}
