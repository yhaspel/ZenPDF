import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ConfirmService } from './confirm.service';
import { ZenModal } from './modal.directive';

/**
 * The confirm dialog. Filled danger is allowed here and only here — the final
 * confirmation inside a confirm panel (design contract §3 buttons).
 */
@Component({
  selector: 'app-confirm-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ZenModal],
  template: `
    @if (confirm.current(); as req) {
      <div class="scrim" data-test="confirm-host">
        <div class="modal"
             zenModal role="dialog" aria-modal="true"
             [attr.aria-label]="req.message"
             (zenModalEscape)="confirm.answer(false)">
          <p class="text-ink mb-6 whitespace-pre-line">{{ req.message }}</p>
          @if (req.requireText) {
            <label class="mb-6">
              Type <strong class="text-ink">{{ req.requireText }}</strong> to continue
              <input
                class="input mt-1"
                [ngModel]="typed()"
                (ngModelChange)="typed.set($event)"
                data-test="confirm-text"
              />
            </label>
          }
          <div class="modal-actions">
            <button
              class="btn btn-ghost"
              (click)="confirm.answer(false)"
              data-test="confirm-cancel"
            >
              Cancel
            </button>
            <button
              class="btn btn-danger-filled"
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
