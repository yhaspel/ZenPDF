import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex items-center justify-center p-6" data-test="spinner">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-600"></div>
    </div>
  `,
})
export class Spinner {}
