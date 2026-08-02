import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ConfirmService } from './confirm.service';
import { ZenModal } from './modal.directive';

@Component({
  selector: 'app-confirm-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ZenModal],
  template: `
    @if (confirm.current(); as req) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-test="confirm-host">
        <div class="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
             zenModal role="dialog" aria-modal="true"
             [attr.aria-label]="req.message"
             (zenModalEscape)="confirm.answer(false)">
          <p class="mb-6 whitespace-pre-line text-slate-700">{{ req.message }}</p>
          @if (req.requireText) {
            <label class="mb-6 block text-sm text-slate-500">
              Type <strong class="text-slate-700">{{ req.requireText }}</strong> to continue
              <input
                class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-800"
                [ngModel]="typed()"
                (ngModelChange)="typed.set($event)"
                data-test="confirm-text"
              />
            </label>
          }
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-slate-600 hover:bg-slate-100"
              (click)="confirm.answer(false)"
              data-test="confirm-cancel"
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-rose-700 px-4 py-2 text-white hover:bg-rose-700 disabled:opacity-40"
              [disabled]="!!req.requireText && typed().trim() !== req.requireText"
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
  protected typed = signal('');

  constructor() {
    // A fresh prompt must never inherit the previous one's typed confirmation.
    effect(() => {
      this.confirm.current();
      this.typed.set('');
    });
  }
}
