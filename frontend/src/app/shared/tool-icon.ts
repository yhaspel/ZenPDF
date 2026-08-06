import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The 24 tool icons (design contract §2 icon grid): 24×24 viewBox, 20×20 live
 * area, stroke 1.5, round caps/joins, no fills — except the redact bar, which
 * fills with currentColor by specified exception. Icons inherit currentColor.
 *
 * Drawn inline rather than sprited: they prerender with the page, they need no
 * fetch, and the sanitizer never gets a say.
 */
@Component({
  selector: 'app-tool-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
      @switch (slug()) {
        @case ('merge-pdf') {
          <rect x="3.5" y="3.5" width="7" height="9.5" rx="1" />
          <rect x="13.5" y="3.5" width="7" height="9.5" rx="1" />
          <path d="M12 13.5v6" />
          <path d="m9.5 17.5 2.5 2.5 2.5-2.5" />
        }
        @case ('split-pdf') {
          <rect x="8.5" y="3.5" width="7" height="9.5" rx="1" />
          <path d="M12 13v2.5l-4.5 4.5M12 15.5 16.5 20" />
          <path d="M9.8 20.3H7.2v-2.6M14.2 20.3h2.6v-2.6" />
        }
        @case ('organize-pdf') {
          <rect x="4" y="4" width="7" height="7" rx="1" />
          <rect x="13" y="4" width="7" height="7" rx="1" />
          <rect x="4" y="13" width="7" height="7" rx="1" />
          <path d="M16.5 13.5v6M13.5 16.5h6" />
        }
        @case ('rotate-pdf') {
          <rect x="7" y="8" width="10" height="12.5" rx="1" />
          <path d="M7 4.5h6a4 4 0 0 1 4 4v1" />
          <path d="m15.2 7.7 1.8 1.8 1.8-1.8" />
        }
        @case ('delete-pdf-pages') {
          <rect x="5" y="3.5" width="10.5" height="13.5" rx="1" />
          <circle cx="17" cy="17.5" r="3.75" />
          <path d="M15.2 17.5h3.6" />
        }
        @case ('extract-pdf-pages') {
          <rect x="4.5" y="3.5" width="10.5" height="13.5" rx="1" />
          <path d="M11.5 20.5h8.5M17.4 17.9l2.6 2.6-2.6 2.6" />
        }
        @case ('add-page-numbers') {
          <rect x="6.5" y="3.5" width="11" height="13.5" rx="1" />
          <path d="M9.5 20.5h.01M12 20.5h.01M14.5 20.5h.01" />
        }
        @case ('edit-pdf') {
          <path d="m5 19 .9-3.6L16.3 5a1.8 1.8 0 0 1 2.6 0l.5.5a1.8 1.8 0 0 1 0 2.6L9 18.5 5 19Z" />
          <path d="m14.8 6.5 3 3" />
        }
        @case ('annotate-pdf') {
          <path d="M6 14.5 14 6.4a1.7 1.7 0 0 1 2.4 0l1.6 1.6a1.7 1.7 0 0 1 0 2.4l-8.1 8H6v-3.9Z" />
          <path d="M4 21.5h16" />
        }
        @case ('fill-pdf-form') {
          <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
          <path d="m5.9 7.3 1.3 1.3 2.3-2.7" />
          <path d="M14 6h6M14 8.8h4.5" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
          <path d="M14 15.5h6M14 18.3h4.5" />
        }
        @case ('watermark-pdf') {
          <rect x="4.5" y="3.5" width="12" height="15" rx="1" />
          <path d="M17.5 13.8s2.9 3 2.9 4.8a2.9 2.9 0 0 1-5.8 0c0-1.8 2.9-4.8 2.9-4.8Z" />
        }
        @case ('pdf-to-word') {
          <rect x="3.5" y="5.5" width="7.5" height="10" rx="1" />
          <path d="M12.5 10.5h3.2M14.2 8.6l1.9 1.9-1.9 1.9" />
          <path d="m16.3 13.5 1.4 5 1.3-3.2 1.3 3.2 1.4-5" />
        }
        @case ('word-to-pdf') {
          <path d="m2.3 5.5 1.4 5 1.3-3.2 1.3 3.2 1.4-5" />
          <path d="M8.5 13.5h3.2M10.2 11.6l1.9 1.9-1.9 1.9" />
          <rect x="13" y="8.5" width="7.5" height="10" rx="1" />
        }
        @case ('jpg-to-pdf') {
          <rect x="3.5" y="4.5" width="10" height="8" rx="1" />
          <circle cx="6.6" cy="7.2" r="1" />
          <path d="m5 12.5 2.8-3.2 2.4 3.2" />
          <path d="M10.5 17.5h3M12 15.8l1.7 1.7-1.7 1.7" />
          <rect x="15.5" y="13" width="5.5" height="7.5" rx="1" />
        }
        @case ('pdf-to-jpg') {
          <rect x="3.5" y="3.5" width="5.5" height="7.5" rx="1" />
          <path d="M10 7.5h3M11.5 5.8l1.7 1.7-1.7 1.7" />
          <rect x="10.5" y="12" width="10" height="8.5" rx="1" />
          <circle cx="13.6" cy="14.8" r="1" />
          <path d="m12 20.5 3-3.4 2.6 3.4" />
        }
        @case ('html-to-pdf') {
          <path d="m8.5 5.5-5 6.5 5 6.5M15.5 5.5l5 6.5-5 6.5" />
          <path d="M13.2 4.5 10.8 19.5" />
        }
        @case ('ocr-pdf') {
          <path
            d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
          <path d="M8 10h8M8 13.5h5.5" />
        }
        @case ('compress-pdf') {
          <rect x="6.5" y="9" width="11" height="6" rx="1" />
          <path d="M12 2.5v4M10 4.7l2 1.8 2-1.8M12 21.5v-4M10 19.3l2-1.8 2 1.8" />
        }
        @case ('repair-pdf') {
          <path
            d="M14.8 6.3a4.2 4.2 0 0 0-5.6 5.2l-4.7 4.7a1.8 1.8 0 0 0 2.5 2.5l4.7-4.7a4.2 4.2 0 0 0 5.2-5.6L14 11.3l-2.1-2.1 2.9-2.9Z" />
        }
        @case ('compare-pdf') {
          <rect x="3.5" y="4.5" width="7" height="9.5" rx="1" />
          <rect x="13.5" y="10" width="7" height="9.5" rx="1" />
          <path d="M13.5 5.5h4.5M16.3 3.7l1.8 1.8-1.8 1.8M10.5 18.5H6M7.7 20.3 5.9 18.5l1.8-1.8" />
        }
        @case ('protect-pdf') {
          <rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
          <path d="M12 14.2v2.3" />
        }
        @case ('unlock-pdf') {
          <rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.1" />
          <path d="M12 14.2v2.3" />
        }
        @case ('redact-pdf') {
          <rect x="5" y="3.5" width="14" height="17" rx="1" />
          <path d="M8 7.5h8" />
          <rect x="8" y="10.8" width="8" height="2.6" rx="0.6" fill="currentColor" stroke="none" />
          <path d="M8 17h5" />
        }
        @case ('sign-pdf') {
          <path
            d="M3.5 16.5c2.4-5 4.3-7.3 5.3-6.4s-1.9 6.2-.5 6.7 3.3-3.3 4.3-2.8.6 2.4 1.6 2.4 2-1.4 5.3-1.4" />
          <path d="M4 20.5h16" />
        }
        @default {
          <path d="M6.5 3.5h7l4 4v13h-11z" />
          <path d="M13.5 3.5v4h4" />
        }
      }
    </svg>
  `,
})
export class ToolIcon {
  readonly slug = input.required<string>();
}
