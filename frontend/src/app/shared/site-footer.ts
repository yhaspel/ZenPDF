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
 *
 * Exactly the five existing links plus the fact line — nothing added (design
 * contract §3 footer, §10).
 */
@Component({
  selector: 'app-site-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <footer class="ftr" data-test="site-footer">
      <p>
        <a routerLink="/about" data-test="footer-about">About</a> ·
        <a routerLink="/legal/privacy" data-test="footer-privacy">Privacy</a> ·
        <a routerLink="/legal/terms" data-test="footer-terms">Terms</a> ·
        <a routerLink="/legal/esign-disclosure" data-test="footer-esign">E-sign disclosure</a> ·
        <a routerLink="/verify" data-test="footer-verify">Verify a signed PDF</a>
      </p>
      <p class="ftr-fact">Free, paid for by advertising. Files are deleted automatically.</p>
    </footer>
  `,
})
export class SiteFooter {}
