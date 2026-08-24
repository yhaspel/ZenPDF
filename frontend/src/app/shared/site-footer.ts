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
 * Exactly seven links plus the fact line — nothing else added (design contract
 * §3 footer, §10). It was five until 2026-08-24, when Phase 11 added Contact
 * and Guides **on the end**: the original five keep their positions, because
 * they are the set a reviewer scans for and moving Privacy or Terms to make
 * room for a newcomer is the one thing that set should never do.
 *
 * The links live in a single `<p>` with middot separators so the row wraps as
 * *text* rather than as a grid — at 390 px it breaks onto a second centred
 * line instead of overflowing.
 *
 * **This is not the ceremony's footer.** That one is written out inline in
 * `ceremony.html` with its own five links and the not-a-QES sentence, and it
 * deliberately does not gain these two — a stranger mid-signature is being
 * asked to read less, not more (§3, §10; `site-footer.spec.ts` holds both
 * sets).
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
        <a routerLink="/verify" data-test="footer-verify">Verify a signed PDF</a> ·
        <a routerLink="/contact" data-test="footer-contact">Contact</a> ·
        <a routerLink="/guides" data-test="footer-guides">Guides</a>
      </p>
      <p class="ftr-fact">Free, paid for by advertising. Files are deleted automatically.</p>
    </footer>
  `,
})
export class SiteFooter {}
