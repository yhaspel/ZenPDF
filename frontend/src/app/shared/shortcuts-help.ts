import { ChangeDetectionStrategy, Component, computed, output } from '@angular/core';

import { ZenModal } from './modal.directive';
import { EDITOR_SHORTCUTS, ShortcutSpec, isApplePlatform, keyLabel } from './shortcuts';

interface HelpGroup {
  name: string;
  rows: { label: string; keys: { glyph: string; name: string }[] }[];
}

/**
 * The shortcuts sheet (design contract §3 modals).
 *
 * Rendered from `EDITOR_SHORTCUTS`, the same array `resolveShortcut` is
 * specified against, so the sheet cannot describe a key the app does not
 * honour — or miss one it does.
 *
 * Two accessibility details that are easy to get wrong here:
 *
 * * A bare ⌘ is announced as "place of interest sign" and ⇧ as "upwards white
 *   arrow", so every glyph carries the word it stands for as its label.
 * * `.modal` is a scroll container and Safari does not make scrollers
 *   keyboard-focusable, so a list longer than the viewport would be unreachable
 *   inside the focus trap. The list is therefore a focusable labelled region —
 *   the same pattern the contract already requires of the e-sign disclosure.
 */
@Component({
  selector: 'app-shortcuts-help',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ZenModal],
  template: `
    <div class="scrim" data-test="shortcuts-help"
         zenModal role="dialog" aria-modal="true" aria-labelledby="shortcuts-help-title"
         (zenModalEscape)="closed.emit()">
      <div class="modal">
        <h3 id="shortcuts-help-title">Keyboard shortcuts</h3>
        <div class="max-h-[60vh] overflow-auto" tabindex="0" role="region"
             aria-label="Keyboard shortcuts">
          @for (group of groups(); track group.name) {
            <p class="kicker mt-3 first:mt-0">{{ group.name }}</p>
            <ul>
              @for (row of group.rows; track row.label) {
                <li class="border-border flex items-center gap-3 border-b py-2 last:border-b-0"
                    data-test="shortcut-row">
                  <span class="text-ink flex-1 text-sm">{{ row.label }}</span>
                  <span class="flex shrink-0 gap-1">
                    @for (k of row.keys; track $index) {
                      <kbd class="kbd" [attr.aria-label]="k.name">{{ k.glyph }}</kbd>
                    }
                  </span>
                </li>
              }
            </ul>
          }
        </div>
        <p class="faint mt-3 text-[12.5px]">
          Shortcuts stay out of the way while you are typing in a field.
        </p>
        <div class="modal-actions">
          <button class="btn btn-secondary" (click)="closed.emit()"
                  data-test="shortcuts-close">Close</button>
        </div>
      </div>
    </div>
  `,
})
export class ShortcutsHelp {
  readonly closed = output<void>();

  protected readonly groups = computed<HelpGroup[]>(() => {
    const apple = isApplePlatform();
    const order: ShortcutSpec['group'][] = ['Editing', 'Placing', 'Everywhere'];
    return order
      .map((name) => ({
        name,
        rows: EDITOR_SHORTCUTS.filter((s) => s.group === name).map((s) => ({
          label: s.label,
          keys: s.keys.map((k) => keyLabel(k, apple)),
        })),
      }))
      .filter((group) => group.rows.length > 0);
  });
}
