import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthFacade } from '../../abstraction/auth.facade';
import { DocumentsFacade } from '../../abstraction/documents.facade';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="mx-auto max-w-2xl p-6">
      <h1 class="mb-6 text-2xl font-bold text-slate-800">Settings</h1>
      <div class="rounded-xl bg-white p-6 shadow-sm">
        <h2 class="mb-4 font-semibold text-slate-700">Profile</h2>
        <label class="mb-1 block text-sm text-slate-500">Email</label>
        <input [value]="auth.user()?.email" disabled
               class="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-500" />
        <label class="mb-1 block text-sm text-slate-500">Display name</label>
        <div class="flex gap-2">
          <input [(ngModel)]="displayName" class="flex-1 rounded-lg border border-slate-300 px-3 py-2" data-test="display-name" />
          <button (click)="save()" class="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700" data-test="save-profile">
            Save
          </button>
        </div>
      </div>

      <div class="mt-6 rounded-xl bg-white p-6 shadow-sm">
        <h2 class="mb-4 font-semibold text-slate-700">Storage</h2>
        @if (docs.usage(); as u) {
          <div class="mb-2 h-3 w-full overflow-hidden rounded-full bg-slate-100">
            <div class="h-full bg-indigo-500" [style.width.%]="docs.storagePercent()"></div>
          </div>
          <p class="text-sm text-slate-500">
            {{ (u.storage.used_bytes / 1048576).toFixed(1) }} MB of
            {{ (u.storage.quota_bytes / 1048576).toFixed(0) }} MB used
          </p>
        }
      </div>
    </div>
  `,
})
export class Settings {
  protected auth = inject(AuthFacade);
  protected docs = inject(DocumentsFacade);
  private toast = inject(ToastService);
  protected displayName = '';

  constructor() {
    this.displayName = this.auth.user()?.display_name ?? '';
    this.docs.refreshUsage();
  }

  save(): void {
    this.auth.updateProfile({ display_name: this.displayName }).subscribe({
      next: () => this.toast.success('Profile updated'),
      error: () => this.toast.error('Could not update profile'),
    });
  }
}
