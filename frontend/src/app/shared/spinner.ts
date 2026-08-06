import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The breath (design contract §3): a vermilion circle that scales and fades on
 * a 2.6 s cycle. No frantic spinners anywhere. Under reduced motion the circle
 * rests at full scale (styles.scss owns that rule).
 */
@Component({
  selector: 'app-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex items-center justify-center p-6" data-test="spinner">
      <div class="breath-dot" aria-hidden="true"></div>
    </div>
  `,
})
export class Spinner {}
