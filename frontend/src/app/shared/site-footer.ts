import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * The footer, once (§9A).
 *
 * Every page carries the same links, including the ones inside the product and
 * the signing ceremony. Two reasons, and neither is decoration: an ad network's
 * review looks for reachable policy pages from anywhere on the site, and a
 * stranger who has just been mailed a document they did not expect needs to
 * find out who we are without leaving the page they are on.
 */
@Component({
  selector: 'app-site-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <footer class="border-t border-slate-200 px-6 py-5 text-center text-xs text-slate-500"
            data-test="site-footer">
      <p>
        <a routerLink="/about" class="underline" data-test="footer-about">About</a> ·
        <a routerLink="/legal/privacy" class="underline" data-test="footer-privacy">Privacy</a> ·
        <a routerLink="/legal/terms" class="underline" data-test="footer-terms">Terms</a> ·
        <a routerLink="/legal/esign-disclosure" class="underline" data-test="footer-esign">E-sign disclosure</a> ·
        <a routerLink="/verify" class="underline" data-test="footer-verify">Verify a signed PDF</a>
      </p>
    </footer>
  `,
})
export class SiteFooter {}
