import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * An empty state is a folded sheet (design contract §3): quiet paper, a faint
 * document icon, a display title. At most one per screen — it shares the
 * `.sheet` motif with trust notices. No emoji (§9).
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sheet mx-auto flex w-full max-w-md flex-col items-center gap-2 px-8 py-12 text-center"
         data-test="empty-state">
      <svg class="ti text-ink-faint" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 3.5h7l4 4v13h-11z" />
        <path d="M13.5 3.5v4h4" />
      </svg>
      <p class="empty-title">{{ title() }}</p>
      @if (subtitle()) {
        <p class="text-[13.5px] text-ink-muted">{{ subtitle() }}</p>
      }
    </div>
  `,
})
export class EmptyState {
  readonly title = input('Nothing here yet');
  readonly subtitle = input('');
}
