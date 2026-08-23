import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';

import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { ViewerFacade } from '../../abstraction/viewer.facade';
import { Workspace } from './workspace';

/**
 * The workspace bar's version-level Undo and Redo (phase-12 D11, D-D).
 *
 * A revert *appends*, so the version whose content is on screen and
 * `currentSeq()` are two different numbers as soon as one Undo has happened —
 * and the first cut of this button ignored that. `undoLastChange` always
 * reverted to `currentSeq() - 1`: at v5 that is v4, correctly; but the revert
 * makes v6, so pressing Undo again reverted to **v5, the change just undone**.
 * Undo was single-shot and silently became Redo on the second press.
 */
describe('Workspace — version undo and redo', () => {
  let reverted: number[];
  /** A real signal, because `canRedoVersion` is a computed that reads it. */
  let seq: WritableSignal<number>;
  let fixture: ComponentFixture<Workspace>;
  /**
   * What the server does with the next revert.
   *
   * `refused` is the guest's 429 — an HTTP error on the create call, so it
   * never becomes a job at all; `failed` is a job that ran and lost (a `locked`
   * document, a `version_conflict`). The cursor has to survive both.
   */
  let outcome: 'succeeded' | 'failed' | 'refused';

  function build(startAt: number) {
    reverted = [];
    outcome = 'succeeded';
    seq = signal(startAt);
    const fakeDocs: Partial<DocumentsService> = {
      get: () => of({ id: 'doc-1', title: 'A file' } as DocumentModel) as never,
      versions: () => of({ count: 0, next: null, previous: null, results: [] }) as never,
      outline: () => of({ outline: [] }) as never,
      contentUrl: () => '',
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: DocumentsService, useValue: fakeDocs },
        // The real facade polls `GET /jobs/:id/` after the create call, which
        // under `provideHttpClientTesting` never answers — so the revert would
        // never finish and `trackReload` would never run. The cursor is now
        // written *there*, so the job has to be allowed to land.
        { provide: JobsFacade, useValue: { dispatch: (create$: Observable<Job>) => create$ } },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'doc-1' })),
            queryParamMap: of(convertToParamMap({})),
            snapshot: { paramMap: convertToParamMap({ id: 'doc-1' }) },
          },
        },
      ],
    });

    const viewer = TestBed.inject(ViewerFacade);
    // Stand in for the server: a revert appends a version holding `target`'s
    // content, which is the whole reason a cursor is needed.
    (viewer as unknown as { revert(s: number): Observable<Job> }).revert = (target: number) => {
      reverted.push(target);
      if (outcome === 'refused') {
        return throwError(() => new HttpErrorResponse({ status: 429, statusText: 'Too Many Requests' }));
      }
      if (outcome === 'failed') {
        return of({ id: 'job', status: 'failed', error_message: 'Document is locked' } as Job);
      }
      seq.update((v) => v + 1);
      return of({ id: 'job', status: 'succeeded' } as Job);
    };
    Object.defineProperty(viewer, 'currentSeq', { value: seq });

    fixture = TestBed.createComponent(Workspace);
    fixture.detectChanges();
    return fixture.componentInstance as unknown as {
      canUndoVersion(): boolean;
      canRedoVersion(): boolean;
      undoTarget(): number;
      redoTarget(): number;
      undoLastChange(): void;
      redoLastChange(): void;
    };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('goes back one version at a time, and keeps going back', () => {
    const bar = build(5);

    bar.undoLastChange(); // v5 → revert to v4, appending v6
    bar.undoLastChange(); // showing v4 → revert to v3, appending v7

    expect(reverted).toEqual([4, 3]);
  });

  it('offers Redo only after an Undo, and only forward', () => {
    const bar = build(5);
    expect(bar.canRedoVersion()).toBe(false);

    bar.undoLastChange();
    expect(bar.canRedoVersion()).toBe(true);
    expect(bar.redoTarget()).toBe(5);

    bar.redoLastChange();
    // Back where we started: there is nothing further forward to go to.
    expect(bar.canRedoVersion()).toBe(false);
    expect(reverted).toEqual([4, 5]);
  });

  it('never lets Undo and Redo mean the same thing', () => {
    const bar = build(5);
    bar.undoLastChange();
    expect(bar.canUndoVersion()).toBe(true);
    expect(bar.canRedoVersion()).toBe(true);
    expect(bar.undoTarget()).not.toBe(bar.redoTarget());
    expect(bar.undoTarget()).toBe(3);
    expect(bar.redoTarget()).toBe(5);
  });

  it('cannot redo past where the chain started', () => {
    const bar = build(5);
    bar.undoLastChange();
    bar.undoLastChange();
    bar.redoLastChange();
    bar.redoLastChange();
    expect(bar.canRedoVersion()).toBe(false);
    expect(reverted).toEqual([4, 3, 4, 5]);
  });

  it('ends the chain when any other operation appends a version', () => {
    const bar = build(5);
    bar.undoLastChange();
    expect(bar.canRedoVersion()).toBe(true);

    seq.update((v) => v + 1); // somebody rotated a page, cropped, saved…
    expect(bar.canRedoVersion()).toBe(false);
    // …and Undo goes back from where the document actually is now.
    expect(bar.undoTarget()).toBe(seq() - 1);
  });

  it('has nothing to undo at v1', () => {
    const bar = build(1);
    expect(bar.canUndoVersion()).toBe(false);
    bar.undoLastChange();
    expect(reverted).toEqual([]);
  });

  // ------------------------------------------------------------------ //
  // A revert that does not land (2026-08-23)
  //
  // The cursor used to be written before the dispatch, so a refused revert
  // left `expected` pointing at a version `currentSeq` would never reach: the
  // next press read the chain as dead, Undo silently fell back to
  // `currentSeq − 1`, and Redo went away. Measured on production at v5 showing
  // v1, where a throttled Redo left the bar offering v4.
  // ------------------------------------------------------------------ //

  /** The bar as a person reads it: what the two buttons say and whether they work. */
  function bar(): { undo: [string, boolean]; redo: [string, boolean] } {
    fixture.detectChanges();
    const read = (test: string): [string, boolean] => {
      const el = fixture.nativeElement.querySelector(`[data-test=${test}]`) as HTMLButtonElement;
      return [el.title, el.disabled];
    };
    return { undo: read('undo-version'), redo: read('redo-version') };
  }

  it('leaves Undo and Redo exactly as they were when an Undo is refused', () => {
    const ws = build(5);
    ws.undoLastChange();          // v5 → v4, appending v6: the chain is live
    const before = bar();
    expect(before.undo).toEqual(['Undo the last change — back to v3', false]);
    expect(before.redo).toEqual(['Redo — forward to v5', false]);

    outcome = 'refused';          // the guest's 429 on the create call
    ws.undoLastChange();

    expect(reverted).toEqual([4, 3]);   // it was asked for, and refused
    expect(seq()).toBe(6);              // no version appended
    expect(bar()).toEqual(before);
    expect(ws.canRedoVersion()).toBe(true);
    expect(ws.undoTarget()).toBe(3);
    expect(ws.redoTarget()).toBe(5);
  });

  it('leaves Undo and Redo exactly as they were when a Redo fails', () => {
    const ws = build(5);
    ws.undoLastChange();
    const before = bar();

    outcome = 'failed';           // the job ran and lost — a locked document
    ws.redoLastChange();

    expect(reverted).toEqual([4, 5]);
    expect(seq()).toBe(6);
    expect(bar()).toEqual(before);
    expect(ws.canRedoVersion()).toBe(true);
    expect(ws.redoTarget()).toBe(5);
  });

  it('picks the chain back up on the next press, once the window has passed', () => {
    const ws = build(5);
    ws.undoLastChange();
    outcome = 'refused';
    ws.redoLastChange();
    expect(ws.canRedoVersion()).toBe(true);

    outcome = 'succeeded';
    ws.redoLastChange();

    expect(reverted).toEqual([4, 5, 5]);
    expect(ws.canRedoVersion()).toBe(false);   // back where the chain started
    expect(bar().undo).toEqual(['Undo the last change — back to v4', false]);
  });
});
