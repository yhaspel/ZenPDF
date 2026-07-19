import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col items-center justify-center gap-2 p-12 text-center text-slate-400"
         data-test="empty-state">
      <div class="text-4xl">{{ icon() }}</div>
      <p class="text-lg font-medium text-slate-500">{{ title() }}</p>
      @if (subtitle()) {
        <p class="text-sm">{{ subtitle() }}</p>
      }
    </div>
  `,
})
export class EmptyState {
  readonly icon = input('📄');
  readonly title = input('Nothing here yet');
  readonly subtitle = input('');
}
