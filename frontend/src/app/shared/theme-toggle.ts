import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ThemeService } from '../core/services/theme.service';

/**
 * The theme toggle (design contract §5): a 44×44 icon button on every header
 * variant, including the ceremony and auth pages. Cycles Light → Dark → System;
 * the icon shows the CURRENT preference (sun / moon / monitor), the aria-label
 * announces it.
 */
@Component({
  selector: 'app-theme-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="theme-toggle"
      data-test="theme-toggle"
      [attr.aria-label]="label()"
      [title]="label()"
      (click)="theme.cycle()">
      @switch (theme.preference()) {
        @case ('light') {
          <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6" />
          </svg>
        }
        @case ('dark') {
          <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
          </svg>
        }
        @default {
          <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="12" rx="1.5" />
            <path d="M9.5 21h5M12 17v4" />
          </svg>
        }
      }
    </button>
  `,
})
export class ThemeToggle {
  protected readonly theme = inject(ThemeService);

  protected readonly label = computed(() => {
    const names: Record<string, string> = { light: 'Light', dark: 'Dark', system: 'System' };
    return `Theme: ${names[this.theme.preference()]} — change theme`;
  });
}
