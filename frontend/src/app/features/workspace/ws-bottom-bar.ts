import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { ToolIcon } from '../../shared/tool-icon';

export type WorkspaceMode =
  | 'view' | 'organize' | 'edit' | 'annotate' | 'forms' | 'convert' | 'compare'
  | 'sign' | 'protect';

/**
 * The nine modes, in the order the workspace bar has always listed them, each
 * borrowing the icon of the tool it is (§2 icon grid). `view` is the one with
 * nothing to borrow from and has a glyph of its own — see `ToolIcon`.
 */
export const WORKSPACE_MODES: readonly { key: WorkspaceMode; label: string; icon: string }[] = [
  { key: 'view', label: 'View', icon: 'view' },
  { key: 'organize', label: 'Organize', icon: 'organize-pdf' },
  { key: 'edit', label: 'Edit', icon: 'edit-pdf' },
  { key: 'annotate', label: 'Annotate', icon: 'annotate-pdf' },
  { key: 'forms', label: 'Forms', icon: 'fill-pdf-form' },
  { key: 'convert', label: 'Convert', icon: 'pdf-to-word' },
  { key: 'compare', label: 'Compare', icon: 'compare-pdf' },
  { key: 'sign', label: 'Sign', icon: 'sign-pdf' },
  { key: 'protect', label: 'Protect', icon: 'protect-pdf' },
];

/**
 * The phone workspace's bottom bar (design contract §3 **Phone workspace**).
 *
 * Two rows. The **action row** carries one opener per rail the current mode
 * has, and — docked at its end — the mode's own Undo/Redo and its primary,
 * which the pane publishes through `WorkspaceShellFacade`. The **mode row** is
 * the nine modes as icon-over-label buttons, scrolling inside itself.
 *
 * Presentation only: it reads the shell facade and emits a mode; it owns no
 * state and knows nothing about documents.
 *
 * **Tapping the active mode does nothing.** The desktop `.seg` toggles back to
 * View on a second click, which is a useful accelerator with a pointer and a
 * trap on a phone, where the same tap is how you check you are where you think
 * you are. `aria-pressed` already says which mode is on, and View is the first
 * button in the row — the way out is visible rather than hidden in a gesture.
 */
@Component({
  selector: 'app-ws-bottom-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ToolIcon],
  host: { class: 'ws-bottom-bar', 'data-test': 'ws-bottom-bar' },
  template: `
    <div class="ws-bottom-actions">
      <div class="ws-bottom-openers">
        @for (drawer of shell.barDrawers(); track drawer.key) {
          <button type="button" class="btn btn-ghost btn-sm"
                  [id]="'ws-drawer-open-' + drawer.key"
                  [attr.aria-expanded]="shell.openDrawer() === drawer.key"
                  [attr.aria-controls]="'ws-drawer-' + drawer.key"
                  [attr.data-drawer]="drawer.key"
                  (click)="shell.toggleDrawer(drawer.key)"
                  data-test="ws-drawer-open">{{ drawer.label }}</button>
        }
      </div>
      @if (shell.paneActions(); as actions) {
        <div class="ws-bottom-dock">
          @if (actions.undo; as undo) {
            <button type="button" class="btn btn-ghost btn-sm ws-bottom-icon"
                    [disabled]="undo.disabled" (click)="undo.run()"
                    [attr.aria-label]="undo.label" [title]="undo.label"
                    data-test="ws-bottom-undo">
              <svg class="ti ti-sm" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4.5 9.5h9a5 5 0 0 1 0 10H8" />
                <path d="m8 5 -3.5 4.5L8 14" />
              </svg>
            </button>
          }
          @if (actions.redo; as redo) {
            <button type="button" class="btn btn-ghost btn-sm ws-bottom-icon"
                    [disabled]="redo.disabled" (click)="redo.run()"
                    [attr.aria-label]="redo.label" [title]="redo.label"
                    data-test="ws-bottom-redo">
              <svg class="ti ti-sm" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19.5 9.5h-9a5 5 0 0 0 0 10H16" />
                <path d="m16 5 3.5 4.5L16 14" />
              </svg>
            </button>
          }
          @if (actions.primary; as primary) {
            <button type="button" class="btn btn-primary btn-sm"
                    [disabled]="primary.disabled" (click)="primary.run()"
                    data-test="ws-bottom-primary">{{ primary.label }}</button>
          }
        </div>
      }
    </div>

    <div class="ws-bottom-modes" role="group" aria-label="Workspace mode">
      @for (item of modes; track item.key) {
        <button type="button" class="ws-bottom-mode"
                [class.seg-active]="mode() === item.key"
                [attr.aria-pressed]="mode() === item.key"
                [attr.data-mode]="item.key"
                (click)="modeChange.emit(item.key)"
                data-test="ws-bottom-mode">
          <app-tool-icon [slug]="item.icon" />
          <span>{{ item.label }}</span>
        </button>
      }
    </div>
  `,
})
export class WsBottomBar {
  readonly mode = input.required<WorkspaceMode>();
  readonly modeChange = output<WorkspaceMode>();

  protected shell = inject(WorkspaceShellFacade);
  protected readonly modes = WORKSPACE_MODES;
}
