import { MediaMatcher } from '@angular/cdk/layout';
import { Injectable, computed, inject, signal } from '@angular/core';

/** One control the bottom bar draws on the active mode's behalf. */
export interface PaneAction {
  label: string;
  disabled: boolean;
  run: () => void;
}

/**
 * What the active pane hands the bottom bar (design contract §3 Phone
 * workspace).
 *
 * Undo/Redo and the mode's primary, and nothing else — the bar is 390 px wide
 * and the drawer openers already own the start of the row.
 */
export interface PaneActions {
  undo?: PaneAction;
  redo?: PaneAction;
  primary?: PaneAction;
}

/** A rail that has said "on a phone, I am a drawer, and this is my name". */
export interface DrawerHandle {
  key: string;
  label: string;
  /**
   * Whether the bottom bar draws an opener for it.
   *
   * True for every rail, because a rail unreachable from the bar is the dead
   * affordance D8 forbids. False for the workspace bar's **More** sheet, which
   * has its own `⋯` in the top bar and would otherwise be offered twice.
   */
  barOpener: boolean;
}

/**
 * The workspace's *shell* state: what the phone layout needs and the document
 * does not (design contract §3 Phone workspace).
 *
 * **Why a facade and not the workspace component's own signals.** The prompt
 * that commissioned this offered two homes — the component, "because it is view
 * state", or `ViewerFacade` "if another component needs it". Another component
 * does: the drawers *are* the seven panes' rails, and the bottom bar that opens
 * them is drawn by the workspace, so opener and drawer are always in different
 * components. That rules out the first. It is not `ViewerFacade` either,
 * because that facade is about the document — its versions, its outline, its
 * errors — and none of this outlives a viewport change, let alone a document.
 * A third, small facade keeps both of them honest.
 *
 * `providedIn: 'root'` because the panes inject it by type and the workspace is
 * a singleton screen; every field resets in `reset()` when a mode changes, so
 * nothing leaks from one mode into the next.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceShellFacade {
  private media = inject(MediaMatcher);

  /**
   * Below the contract's `md` (768 px).
   *
   * `MediaMatcher` rather than `window.matchMedia` for the same reason the rest
   * of the app avoids it directly: it answers on the server too (with `false`,
   * which is the right default — a prerender has no viewport and the desktop
   * layout is the one that degrades gracefully).
   */
  private readonly query = this.media.matchMedia('(max-width: 767px)');
  private readonly narrow = signal(this.query.matches);
  readonly phone = this.narrow.asReadonly();

  private readonly drawerList = signal<DrawerHandle[]>([]);
  /** Every drawer the screen currently has, in registration order. */
  readonly drawers = this.drawerList.asReadonly();
  /** The subset the bottom bar offers an opener for. */
  readonly barDrawers = computed(() => this.drawerList().filter((d) => d.barOpener));

  private readonly open = signal<string | null>(null);
  /** Which drawer is open — at most one, ever (§3: two sheets is no page). */
  readonly openDrawer = this.open.asReadonly();
  readonly anyDrawerOpen = computed(() => this.open() !== null);

  private readonly actions = signal<PaneActions>({});
  readonly paneActions = this.actions.asReadonly();

  constructor() {
    // `change` rather than the deprecated `addListener`, and no teardown: this
    // is a root singleton and the listener outlives every consumer by design.
    this.query.addEventListener?.('change', (event) => {
      this.narrow.set(event.matches);
      // A drawer is a phone shape. Widening the window mid-session must not
      // leave a `role="dialog"` rail with a focus trap sitting in the desktop
      // three-pane row.
      if (!event.matches) this.open.set(null);
    });
  }

  /** A rail announces itself on init; it withdraws on destroy. */
  registerDrawer(handle: DrawerHandle): void {
    this.drawerList.update((list) => {
      const at = list.findIndex((d) => d.key === handle.key);
      if (at < 0) return [...list, handle];
      if (list[at].label === handle.label && list[at].barOpener === handle.barOpener) return list;
      const next = [...list];
      next[at] = handle;
      return next;
    });
  }

  unregisterDrawer(key: string): void {
    this.drawerList.update((list) => list.filter((d) => d.key !== key));
    if (this.open() === key) this.open.set(null);
  }

  toggleDrawer(key: string): void {
    this.open.update((current) => (current === key ? null : key));
  }

  closeDrawer(): void {
    this.open.set(null);
  }

  /** The active pane publishes its Undo/Redo/primary for the bottom bar. */
  setPaneActions(actions: PaneActions): void {
    this.actions.set(actions);
  }

  /**
   * A mode is leaving. Its drawers and its actions go with it.
   *
   * Called by the pane on destroy rather than by the workspace on mode change,
   * because the pane is the thing that knows it is gone — the workspace sets
   * `mode` and Angular tears the old pane down afterwards, so clearing from the
   * workspace would race the new pane's own registration.
   */
  reset(): void {
    this.actions.set({});
    this.open.set(null);
  }
}
