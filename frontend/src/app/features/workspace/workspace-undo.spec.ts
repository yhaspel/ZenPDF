import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of } from 'rxjs';

import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
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

  function build(startAt: number) {
    reverted = [];
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
      seq.update((v) => v + 1);
      return of({ id: 'job', status: 'succeeded' } as Job);
    };
    Object.defineProperty(viewer, 'currentSeq', { value: seq });

    const fixture = TestBed.createComponent(Workspace);
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
});
