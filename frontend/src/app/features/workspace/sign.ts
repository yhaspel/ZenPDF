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
import { Router } from '@angular/router';

import { EsignFacade } from '../../abstraction/esign.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { Job, SavedSignature } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import {
  OverlayDraft,
  OverlayGeometryChange,
  OverlayItem,
  OverlayMenuAction,
} from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { resolveShortcut, shortcutTitle } from '../../shared/shortcuts';
import { ZenModal } from '../../shared/modal.directive';
import { SignaturePad } from '../../shared/signature-pad';
import { ToastService } from '../../shared/toast.service';
import { WsDrawerHead } from '../../shared/ws-drawer-head';
import { WsDrawer } from '../../shared/ws-drawer';
import { FitWidth } from '../../shared/fit-width';
import { clampPageWidth } from '../../shared/page-fit';

/**
 * "Sign myself" (phase-08 §8A).
 *
 * The acceptance criterion is a click count — *self-sign in under four clicks
 * from an open document* — so the panel opens with the signature dialog
 * already up when there is nothing to pick from. Draw, click the page, Apply:
 * three.
 */
/** The widest this pane ever draws a page — its desk width. */
const MAX_PAGE = 680;

@Component({
  selector: 'app-sign',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageOverlay, SignaturePad, ZenModal, WsDrawer, WsDrawerHead, FitWidth],
  templateUrl: './sign.html',
  // Below `md` a mode's host has to be a growing flex item, or the column sizes
  // to its content and the bottom bar floats above the fold — `styles.scss`
  // §17c says it once, with the measurement. Inert at ≥ `md` (§10).
  host: { class: 'ws-pane-host' },
})
export class Sign {
  readonly docId = input.required<string>();
  readonly docTitle = input('');
  readonly pageCount = input(1);
  readonly currentSeq = input<number | null>(null);

  readonly saved = output<Job>();
  readonly conflict = output<void>();

  protected esign = inject(EsignFacade);
  protected guests = inject(GuestFacade);
  private esignSvc = inject(EsignService);
  private router = inject(Router);
  private toast = inject(ToastService);
  private shell = inject(WorkspaceShellFacade);
  private destroyRef = inject(DestroyRef);

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

  protected includeDate = signal(true);
  /**
   * Which placement is selected.
   *
   * Until phase-12 a placement could not be removed at all. `onSelect` called
   * `unplace`, but the overlay only reports a selection while its tool is
   * `select`, and the tool here is `rect` for exactly as long as a signature is
   * armed — which is exactly as long as a placement can exist. So the panel's
   * "Click one to remove it" described a gesture that could never fire. The
   * menu, the ✕ on each row and the Delete key are the real paths.
   */
  protected selectedPlacementId = signal<string | null>(null);
  protected readonly key = shortcutTitle;
  protected padOpen = signal(false);
  protected keepIt = signal(false);

  protected readonly isAccount = computed(() => this.guests.principal() === 'user');

  protected readonly overlayItems = computed<OverlayItem[]>(() =>
    this.esign.placements()
      .filter((p) => p.page === this.page())
      .map((p) => ({
        id: p.id,
        page: p.page,
        shape: 'rect' as const,
        rect: p.rect,
        stroke: '#B23A26',
        fill: '#B23A26',
        opacity: 0.12,
        width: 1,
        label: 'signature',
      })),
  );

  constructor() {
    // What the phone's bottom bar draws on this mode's behalf (design contract
    // §3 Phone workspace). Published rather than duplicated: below `md` the
    // page bar's own pair is `.ws-hoisted`, so exactly one of each is on screen.
    effect(() => this.shell.setPaneActions({
      undo: {
        label: 'Undo the last placement change',
        disabled: !this.esign.canUndo(),
        run: () => this.esign.undoPlacements(),
      },
      redo: {
        label: 'Redo',
        disabled: !this.esign.canRedo(),
        run: () => this.esign.redoPlacements(),
      },
      primary: {
        label: 'Apply',
        disabled: this.esign.busy() || !this.esign.placements().length,
        run: () => this.apply(),
      },
    }));
    this.destroyRef.onDestroy(() => this.shell.reset());

    effect(() => {
      this.docId();
      this.esign.reset();
      // Only for an account. A guest has no library, and *asking* raises the
      // app-wide `account_required` prompt — which would greet a visitor with
      // "create a free account" on a page whose own copy promises they do not
      // need one.
      if (this.guests.principal() === 'user') this.esign.loadSaved();
      // Nothing to pick from → the dialog *is* the first step, which is what
      // keeps the click count honest.
      this.padOpen.set(true);
    });
    effect((onCleanup) => {
      if (typeof window === 'undefined') return;
      const handler = (event: KeyboardEvent) => this.onShortcut(event);
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
    });
  }

  /**
   * Undo and redo the placements from the keyboard.
   *
   * The overlay owns `cancel`, `delete` and the nudges on the focused element,
   * and there is no ⌘S here on purpose: applying a signature seals the file.
   */
  private onShortcut(event: KeyboardEvent): void {
    const action = resolveShortcut(event);
    if (action === 'undo') this.esign.undoPlacements();
    else if (action === 'redo') this.esign.redoPlacements();
    else return;
    event.preventDefault();
  }

  protected signatureUrl(row: SavedSignature): string {
    return this.esignSvc.signatureImageUrl(row.id);
  }

  protected choose(row: SavedSignature): void {
    this.esign.chooseSaved(row);
    this.padOpen.set(false);
  }

  protected onSignature(dataUrl: string): void {
    // Kept for reuse only when the user asked and has somewhere to keep it.
    if (this.keepIt() && this.isAccount()) {
      this.esign.save(dataUrl).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.padOpen.set(false);
          this.toast.success('Signature saved');
        },
        error: () => this.toast.error('Could not save that signature'),
      });
      return;
    }
    this.esign.useImage(dataUrl).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.padOpen.set(false);
        this.toast.info('Now click where it goes');
      },
      error: () => this.toast.error('Could not use that signature'),
    });
  }

  protected onPlaced(draft: OverlayDraft): void {
    if (!draft.rect) return;
    if (!this.esign.hasSignature()) {
      this.padOpen.set(true);
      return;
    }
    this.esign.place(draft.page, draft.rect);
  }

  private overlay = viewChild(PageOverlay);

  protected onSelect(id: string | null): void {
    this.selectedPlacementId.set(id);
    if (id) this.overlay()?.focusSurface();
  }

  protected onGeometryChanged(change: OverlayGeometryChange): void {
    this.esign.movePlacement(change.id, change.rect);
  }

  protected removePlacement(id: string): void {
    this.esign.unplace(id);
    if (this.selectedPlacementId() === id) this.selectedPlacementId.set(null);
  }

  protected onContextTarget(id: string | null): void {
    if (id) this.selectedPlacementId.set(id);
  }

  protected onMenuAction(choice: { action: string; itemId: string | null }): void {
    if (choice.action === 'remove' && choice.itemId) this.removePlacement(choice.itemId);
  }

  protected menuActionsFor = (id: string | null): OverlayMenuAction[] => {
    if (!id || !this.esign.placements().some((p) => p.id === id)) return [];
    return [{
      id: 'remove', label: 'Remove signature', danger: true, shortcut: this.key('delete'),
    }];
  };

  protected placementLabel(index: number, page: number): string {
    return `Signature ${index + 1} · page ${page + 1}`;
  }

  protected apply(): void {
    if (!this.esign.placements().length) {
      this.toast.info('Click the page where the signature goes');
      return;
    }
    this.esign.apply(this.docId(), this.currentSeq(), this.includeDate())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          if (job.status === 'succeeded') {
            this.esign.clear();
            this.toast.success('Signed');
            this.saved.emit(job);
          } else if (job.status === 'failed') {
            this.fail(job);
          }
        },
        error: () => this.toast.error('That did not work'),
      });
  }

  protected sendForSignature(): void {
    this.router.navigate(['/app/sign/new', this.docId()]);
  }

  private fail(job: Job): void {
    if (job.error_code === 'version_conflict') {
      this.toast.info('Document changed — refreshed');
      this.conflict.emit();
      return;
    }
    if (job.error_code === 'account_required') {
      this.toast.info(job.error_message || 'That needs a free account');
      return;
    }
    this.toast.error(job.error_message || 'That did not work');
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount() - 1, p + 1));
  }
}
