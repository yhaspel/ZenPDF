import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { SecurityFacade } from '../../abstraction/security.facade';
import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { Job, PdfPermissions, RedactPattern } from '../../core/models/models';
import { ConfirmService } from '../../shared/confirm.service';
import {
  OverlayDraft,
  OverlayGeometryChange,
  OverlayItem,
  OverlayMenuAction,
} from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { resolveShortcut, shortcutTitle } from '../../shared/shortcuts';
import { ToastService } from '../../shared/toast.service';
import { WsDrawerHead } from '../../shared/ws-drawer-head';
import { WsDrawer } from '../../shared/ws-drawer';
import { FitWidth } from '../../shared/fit-width';
import { clampPageWidth } from '../../shared/page-fit';

export type ProtectTab = 'protect' | 'redact' | 'sanitize';

export const REDACT_PRESETS: { value: string; label: string }[] = [
  { value: 'email', label: 'Email addresses' },
  { value: 'phone', label: 'Phone numbers' },
  { value: 'ssn', label: 'Social security numbers' },
  { value: 'credit_card', label: 'Card numbers' },
  { value: 'iban', label: 'IBANs' },
];

const SANITIZE_ITEMS: { key: string; label: string; note: string }[] = [
  { key: 'metadata', label: 'Document details',
    note: 'Title, author, subject, keywords and the dates.' },
  { key: 'xmp', label: 'XMP metadata',
    note: 'The second, richer metadata block most tools also write.' },
  { key: 'javascript', label: 'Scripts',
    note: 'Anything that runs when the document is opened or clicked.' },
  { key: 'embedded_files', label: 'Attachments',
    note: 'Files carried inside the PDF, which travel with it unnoticed.' },
  { key: 'hidden_layers_flatten', label: 'Hidden layers',
    note: 'Content you cannot see and the file still contains.' },
  { key: 'links_external', label: 'Outbound links',
    note: 'Links to other sites. Jumps within the document are kept.' },
  { key: 'comments', label: 'Comments and markup',
    note: 'Notes, highlights and drawings.' },
];

/** The widest this pane ever draws a page — its desk width. */
const MAX_PAGE = 680;

/**
 * Protect mode (phase-07): password + permissions, redaction, sanitize.
 *
 * Redaction is deliberately two-step for patterns — preview, untick, apply —
 * for the same reason find & replace is: this operation cannot be undone, and
 * "it took more than I meant" is only discoverable afterwards.
 */
@Component({
  selector: 'app-protect',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageOverlay, WsDrawer, WsDrawerHead, FitWidth],
  templateUrl: './protect.html',
  // Below `md` a mode's host has to be a growing flex item, or the column sizes
  // to its content and the bottom bar floats above the fold — `styles.scss`
  // §17c says it once, with the measurement. Inert at ≥ `md` (§10).
  host: { class: 'ws-pane-host' },
})
export class Protect {
  readonly docId = input.required<string>();
  readonly docTitle = input('');
  readonly pageCount = input(1);
  readonly currentSeq = input<number | null>(null);
  readonly isEncrypted = input(false);
  /** Which tab the tool page asked for (`/redact-pdf` → redact). */
  readonly initialTab = input<ProtectTab>('protect');

  readonly saved = output<Job>();
  readonly forked = output<string>();
  readonly conflict = output<void>();

  protected security = inject(SecurityFacade);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private shell = inject(WorkspaceShellFacade);
  private destroyRef = inject(DestroyRef);

  protected readonly presets = REDACT_PRESETS;
  protected readonly sanitizeItems = SANITIZE_ITEMS;

  protected tab = signal<ProtectTab>('protect');
  protected page = signal(0);
  protected zoom = signal(MAX_PAGE);
  /**
   * The pane measured itself; fit the page to it, never wider than the desk
   * value above (`shared/page-fit.ts`). This pane has no zoom control, so a
   * page that does not fit cannot be brought into view at all.
   */
  protected onFit(available: number): void {
    this.zoom.set(clampPageWidth(MAX_PAGE, available));
  }


  constructor() {
    // What the phone's bottom bar draws on this mode's behalf (design contract
    // §3 Phone workspace). Published rather than duplicated: below `md` the
    // page bar's own pair is `.ws-hoisted`, so exactly one of each is on screen.
    effect(() => this.shell.setPaneActions({
      undo: {
        label: 'Undo the last area change',
        disabled: !this.security.canUndo(),
        run: () => this.security.undoAreas(),
      },
      redo: {
        label: 'Redo',
        disabled: !this.security.canRedo(),
        run: () => this.security.redoAreas(),
      },
      ...(this.tab() === 'protect'
        ? {
            primary: {
              label: this.isEncrypted() ? 'Re-protect' : 'Protect',
              disabled: this.security.busy(),
              run: () => this.applyProtection(),
            },
          }
        : {}),
    }));
    this.destroyRef.onDestroy(() => this.shell.reset());

    effect(() => this.tab.set(this.initialTab()));
    // Once the session knows the password — from the prompt, or because the
    // user chose it here — the panel stops asking for it again. It is cleared
    // for a document the session does *not* know, or the previous document's
    // password would be sent and burn one of this one's five attempts.
    effect(() => {
      this.security.unlockedIds();
      this.unlockPassword.set(this.security.passwordFor(this.docId()));
    });
    // The workspace component is reused across /app/doc/:id navigations, so
    // without this the areas drawn on one document are drawn — and applied —
    // on the next one.
    effect(() => {
      this.docId();
      this.security.clear();
      this.page.set(0);
    });
    // The redact keyboard. Its lifetime is the component's, which is what keeps
    // it clear of the pdf.js viewer — that is mounted in View and the Forms
    // fill tab, where this component does not exist.
    effect((onCleanup) => {
      if (typeof window === 'undefined') return;
      const handler = (event: KeyboardEvent) => this.onShortcut(event);
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
    });
  }

  /**
   * Undo and redo the marked areas from the keyboard.
   *
   * Only those two: `cancel`, `delete` and the nudges belong to the overlay,
   * which owns them on the focused element, and there is deliberately no ⌘S —
   * applying a redaction destroys content and appends a version, which is not
   * what anyone means by "save".
   */
  private onShortcut(event: KeyboardEvent): void {
    const action = resolveShortcut(event);
    if (action === 'undo') this.security.undoAreas();
    else if (action === 'redo') this.security.redoAreas();
    else return;
    event.preventDefault();
  }

  // protect
  protected ownerPassword = signal('');
  protected userPassword = signal('');
  protected confirmPassword = signal('');
  protected printLevel = signal<PdfPermissions['print']>('full');
  protected modifyLevel = signal<PdfPermissions['modify']>('full');
  protected allowCopy = signal(true);
  protected unlockPassword = signal('');

  // redact
  protected chosenPresets = signal<string[]>([]);
  protected customPattern = signal('');
  protected searchText = signal('');
  protected matchCase = signal(false);
  protected cleanCopy = signal(true);
  protected redactLabel = signal('');
  protected drawing = signal(false);
  /**
   * Which marked area is selected.
   *
   * New in phase-12, and the reason a click no longer removes one: selecting
   * and destroying used to be the same gesture here — `onSelect` called
   * `removeArea` — so a mis-aimed click deleted work with no confirm and no way
   * back. Now a click selects, the box shows its handles, and removing it is
   * Delete, the menu, or the ✕ on its row.
   */
  protected selectedAreaId = signal<string | null>(null);
  protected readonly key = shortcutTitle;

  // sanitize
  protected sanitizeChoices = signal<Record<string, boolean>>({
    metadata: true, javascript: true, embedded_files: true,
    xmp: true, hidden_layers_flatten: false, links_external: false, comments: false,
  });

  protected readonly passwordStrength = computed(() => strengthOf(this.ownerPassword()));
  protected readonly passwordsMatch = computed(
    () => !this.userPassword() || this.userPassword() === this.confirmPassword(),
  );

  protected readonly overlayItems = computed<OverlayItem[]>(() => {
    const page = this.page();
    const areas: OverlayItem[] = this.security.areas()
      .filter((area) => area.page === page)
      .map((area) => ({
        id: area.id,
        page: area.page,
        shape: 'rect' as const,
        rect: area.rect,
        stroke: '#211C15',
        fill: '#211C15',
        opacity: 0.55,
        width: 2,
        label: 'redact',
      }));
    // Matches still ticked in the review list, so "what would go" is visible on
    // the page and not only as a row in a list. Locked: they are removed by
    // unticking, not by dragging.
    const excluded = this.security.excluded();
    const found: OverlayItem[] = this.security.matches()
      .filter((match) => match.page === page && !excluded.has(match.id))
      .map((match) => ({
        id: match.id,
        page: match.page,
        shape: 'rect' as const,
        rect: match.rect,
        stroke: '#B23A26',
        fill: '#211C15',
        opacity: 0.35,
        width: 1,
        locked: true,
      }));
    return [...areas, ...found];
  });

  // ------------------------------------------------------------------ //
  // Protect
  // ------------------------------------------------------------------ //
  protected applyProtection(): void {
    if (!this.ownerPassword()) {
      this.toast.info('Choose an owner password');
      return;
    }
    if (!this.passwordsMatch()) {
      this.toast.error('The two open passwords do not match');
      return;
    }
    this.security.protect(this.docId(), this.currentSeq(), {
      ownerPassword: this.ownerPassword(),
      userPassword: this.userPassword(),
      permissions: {
        print: this.printLevel(),
        copy: this.allowCopy(),
        modify: this.modifyLevel(),
      },
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          // The user just chose it, so there is no reason to ask again. With no
          // open password the *owner* password is the session credential: the
          // document opens for anyone, and that is the password that lets its
          // owner keep working on it.
          this.security.remember(this.docId(),
                                 this.userPassword() || this.ownerPassword());
        }
        this.onJob(job, 'Document protected');
      },
      error: () => this.fail(),
    });
  }

  protected applyUnlock(): void {
    const password = this.unlockPassword();
    this.security.unlock(this.docId(), this.currentSeq(), password)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (job) => {
        if (job.status === 'succeeded') this.security.forget(this.docId());
        this.onJob(job, 'Password removed');
      },
      error: () => this.fail(),
    });
  }

  protected rememberForSession(): void {
    const password = this.unlockPassword();
    if (!password) {
      this.toast.info('Enter the password');
      return;
    }
    this.security.remember(this.docId(), password);
    this.toast.success('Unlocked for this session');
  }

  protected changePermissions(): void {
    if (!this.ownerPassword()) {
      this.toast.info('The owner password is needed to change restrictions');
      return;
    }
    this.security.changePermissions(this.docId(), this.currentSeq(),
                                    this.ownerPassword(), {
      print: this.printLevel(), copy: this.allowCopy(), modify: this.modifyLevel(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => this.onJob(job, 'Restrictions updated'),
      error: () => this.fail(),
    });
  }

  // ------------------------------------------------------------------ //
  // Redact
  // ------------------------------------------------------------------ //
  protected togglePreset(value: string): void {
    this.chosenPresets.update((chosen) =>
      chosen.includes(value) ? chosen.filter((c) => c !== value) : [...chosen, value],
    );
    this.searchChanged();
  }

  /**
   * The review list describes *one* search. Change what is being looked for
   * and it stops describing anything — and its ids, which are positions in the
   * result, would then point at different matches on apply.
   */
  protected searchChanged(): void {
    if (this.security.report()) this.security.clearReview();
  }

  protected isPreset(value: string): boolean {
    return this.chosenPresets().includes(value);
  }

  protected patterns(): RedactPattern[] {
    const list: RedactPattern[] = this.chosenPresets()
      .map((value) => ({ kind: 'preset' as const, value }));
    if (this.customPattern().trim()) {
      list.push({ kind: 'regex', value: this.customPattern().trim() });
    }
    return list;
  }

  protected onDrawn(draft: OverlayDraft): void {
    if (!draft.rect) return;
    this.security.addArea(draft.page, draft.rect);
  }

  private overlay = viewChild(PageOverlay);

  protected onSelect(id: string | null): void {
    this.selectedAreaId.set(id);
    if (id) this.overlay()?.focusSurface();
  }

  protected onGeometryChanged(change: OverlayGeometryChange): void {
    this.security.moveArea(change.id, change.rect);
  }

  protected removeArea(id: string): void {
    this.security.removeArea(id);
    if (this.selectedAreaId() === id) this.selectedAreaId.set(null);
  }

  protected onContextTarget(id: string | null): void {
    if (id) this.selectedAreaId.set(id);
  }

  protected onMenuAction(choice: { action: string; itemId: string | null }): void {
    if (choice.action === 'remove' && choice.itemId) this.removeArea(choice.itemId);
  }

  /** Only a drawn area has a menu. A pattern match is `locked` and is removed
   *  by unticking it in the review list, which is where its context lives. */
  protected menuActionsFor = (id: string | null): OverlayMenuAction[] => {
    if (!id || !this.security.areas().some((a) => a.id === id)) return [];
    return [{
      id: 'remove', label: 'Remove area', danger: true, shortcut: this.key('delete'),
    }];
  };

  protected areaLabel(index: number, page: number): string {
    return `Area ${index + 1} · page ${page + 1}`;
  }

  /** The user's own regex, checked here so the answer is immediate rather than
   *  a failed job thirty seconds later. */
  protected patternError(): string {
    const source = this.customPattern().trim();
    if (!source) return '';
    try {
      new RegExp(source);
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  }

  protected preview(): void {
    if (!this.patterns().length && !this.searchText().trim()) {
      this.toast.info('Choose what to look for first');
      return;
    }
    if (this.patternError()) {
      this.toast.error('That pattern is not valid — check the highlighted box.');
      return;
    }
    this.security.preview(this.docId(), this.currentSeq(), this.patterns(),
                          this.searchText().trim(), this.matchCase())
                            .pipe(takeUntilDestroyed(this.destroyRef))
                            .subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          const count = this.security.report()?.count ?? 0;
          if (!count) this.toast.info('Nothing matched');
        } else if (job.status === 'failed') {
          this.failure(job);
        }
      },
      error: () => this.fail(),
    });
  }

  protected isKept(id: string): boolean {
    return !this.security.excluded().has(id);
  }

  protected async applyRedaction(): Promise<void> {
    if (!this.security.hasWork()) {
      this.toast.info('Nothing selected to remove');
      return;
    }
    if (this.patternError()) {
      this.toast.error('That pattern is not valid — check the highlighted box.');
      return;
    }
    const kept = this.security.keptIds().length;
    const areas = this.security.areas().length;
    const detail = [
      areas ? `${areas} area(s)` : '',
      kept ? `${kept} match(es)` : '',
    ].filter(Boolean).join(' and ');

    const title = this.docTitle() || 'REDACT';
    if (!(await this.confirm.ask(
      `Permanently remove ${detail} from this document?\n`
      + 'The content is deleted, not hidden — this cannot be undone.'
      + (this.cleanCopy()
        ? '\nThe result goes into a new document, so no earlier version keeps a copy.'
        : '\nEarlier versions in this document will still contain it.'),
      'Remove permanently',
      title,
    ))) return;

    this.security.apply(this.docId(), this.currentSeq(), {
      patterns: this.patterns(),
      searchText: this.searchText().trim(),
      matchCase: this.matchCase(),
      cleanCopy: this.cleanCopy(),
      label: this.redactLabel().trim(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          const residual = (job.result?.['report'] as
            { verification?: { residual_matches?: number } } | undefined
          )?.verification?.residual_matches ?? 0;
          if (residual) {
            this.toast.error(
              `${residual} match(es) are still findable — check for text drawn `
              + 'as an image and use an area instead.',
            );
          } else {
            this.toast.success('Removed');
          }
          this.security.clear();
          const created = (job.result?.['documents'] as string[]) ?? [];
          if (created.length) this.forked.emit(created[0]);
          else this.saved.emit(job);
        } else if (job.status === 'failed') {
          this.failure(job);
        }
      },
      error: () => this.fail(),
    });
  }

  // ------------------------------------------------------------------ //
  // Sanitize
  // ------------------------------------------------------------------ //
  protected toggleSanitize(key: string): void {
    this.sanitizeChoices.update((choices) => ({ ...choices, [key]: !choices[key] }));
  }

  protected applySanitize(): void {
    const chosen = this.sanitizeChoices();
    if (!Object.values(chosen).some(Boolean)) {
      this.toast.info('Choose at least one thing to remove');
      return;
    }
    this.security.sanitize(this.docId(), this.currentSeq(), chosen)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          this.toast.success(describeSanitize(job));
          this.saved.emit(job);
        } else if (job.status === 'failed') {
          this.failure(job);
        }
      },
      error: () => this.fail(),
    });
  }

  // ------------------------------------------------------------------ //
  private onJob(job: Job, label: string): void {
    if (job.status === 'succeeded') {
      this.toast.success(label);
      this.saved.emit(job);
    } else if (job.status === 'failed') {
      this.failure(job);
    }
  }

  private failure(job: Job): void {
    if (job.error_code === 'version_conflict') {
      this.toast.info('Document changed — refreshed');
      this.conflict.emit();
      return;
    }
    if (job.error_code === 'invalid_password') {
      this.toast.error('That password did not open this document.');
      return;
    }
    this.toast.error(job.error_message || 'That did not work');
  }

  private fail(): void {
    this.toast.error('That did not work');
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount() - 1, p + 1));
  }
}

/**
 * Four coarse bands, weighted by *length* rather than by character classes.
 *
 * A meter that calls `P@ssw0rd!` strong and `correct horse battery staple`
 * weak — which is what counting classes does — teaches people to decorate a
 * short word instead of choosing a longer one. Length is what actually costs
 * an attacker time, so that is what this rewards.
 */
export function strengthOf(password: string): { score: number; label: string } {
  if (!password) return { score: 0, label: '' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]
    .filter((re) => re.test(password)).length;
  const length = password.length;
  if (length < 8) return { score: 0, label: 'Too short' };
  if (length >= 16 || (length >= 12 && classes >= 2)) {
    return { score: 3, label: 'Strong' };
  }
  if (length >= 12 || (length >= 10 && classes >= 3)) {
    return { score: 2, label: 'Reasonable' };
  }
  return { score: 1, label: 'Weak' };
}

function describeSanitize(job: Job): string {
  const report = job.result?.['report'] as Record<string, number> | undefined;
  if (!report) return 'Cleaned';
  const parts: string[] = [];
  const names: Record<string, string> = {
    javascript: 'script', embedded_files: 'attachment', metadata: 'metadata field',
    xmp: 'metadata block', hidden_layers_flatten: 'hidden layer',
    links_external: 'outbound link', comments: 'comment',
  };
  for (const [key, label] of Object.entries(names)) {
    const count = report[key] ?? 0;
    if (count) parts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
  }
  return parts.length ? `Removed ${parts.join(', ')}` : 'Nothing left to remove';
}
