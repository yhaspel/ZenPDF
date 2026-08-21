import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { EditFacade } from '../../abstraction/edit.facade';
import {
  PageImage,
  PageLink,
  PageTextBlocks,
  TextBlock,
} from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ConfirmService } from '../../shared/confirm.service';
import { OverlayMenuAction } from '../../shared/page-overlay/overlay-model';
import { Edit, EditMode } from './edit';

const BLOCK: TextBlock = {
  block_id: 0,
  bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
  text: 'The original sentence.',
  lines: [{ bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 }, spans: [
    { text: 'The original sentence.', size: 11, font: 'Helvetica', color: '#211C15',
      bold: false, italic: false, bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } },
  ] }] as TextBlock['lines'],
};

const IMAGE: PageImage = { xref: 7, width: 640, height: 480, bbox: { x: 0.2, y: 0.4, w: 0.3, h: 0.2 } };
const LINK: PageLink = { index: 2, bbox: { x: 0.1, y: 0.8, w: 0.2, h: 0.03 }, kind: 'uri', uri: 'https://example.com' };

const MODEL: PageTextBlocks = {
  page: 0, width: 595, height: 842, rotation: 0, is_scanned_page: false, blocks: [BLOCK],
};

/**
 * Edit mode's local history and its right-click menu (phase-12 §4.2).
 *
 * The scope line matters here: Edit's mode-level Undo covers the **staged**
 * block edits only. Everything else it does — whiteout, add image, watermark —
 * is dispatched to the server and appends a version, and taking that back is
 * the workspace bar's job.
 */
describe('Edit — history, menu and the link that never asked', () => {
  let fixture: ComponentFixture<Edit>;
  let edits: EditFacade;
  let asked: string[];

  const api = () => fixture.componentInstance as unknown as {
    mode: { set(v: EditMode): void };
    onSelect(id: string | null): void;
    onContextTarget(id: string | null): void;
    onMenuAction(c: { action: string; itemId: string | null }): void;
    onDeleteRequested(id: string): void;
    menuActionsFor(id: string | null): OverlayMenuAction[];
    selectedId(): string | null;
    openEditor(block: TextBlock): void;
    draftText: { set(v: string): void; (): string };
    commitEditor(): void;
    deleteLink(link: PageLink): Promise<void>;
  };

  beforeEach(() => {
    asked = [];
    const fakeDocs: Partial<DocumentsService> = {
      textBlocks: () => of(MODEL) as never,
      pageImages: () => of({ page: 0, images: [IMAGE] }) as never,
      pageLinks: () => of({ page: 0, links: [LINK] }) as never,
      thumbnailBlob: () => of(new Blob()) as never,
      // The confirm is what this file is about; the job that follows it is
      // `run`'s business and has its own coverage.
      operation: () => of({ id: 'job-1', status: 'queued' }) as never,
    };
    const fakeConfirm: Partial<ConfirmService> = {
      ask: (message: string) => {
        asked.push(message);
        return Promise.resolve(true);
      },
    };
    TestBed.configureTestingModule({
      imports: [Edit],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DocumentsService, useValue: fakeDocs },
        { provide: ConfirmService, useValue: fakeConfirm },
      ],
    });
    edits = TestBed.inject(EditFacade);
    edits.reset();

    fixture = TestBed.createComponent(Edit);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  describe('staged text edits', () => {
    it('undoes and redoes one staged change at a time', () => {
      api().openEditor(BLOCK);
      api().draftText.set('A different sentence.');
      api().commitEditor();
      expect(edits.pendingEdits().length).toBe(1);
      expect(edits.canUndo()).toBe(true);

      edits.undo();
      expect(edits.pendingEdits().length).toBe(0);

      edits.redo();
      expect(edits.pendingEdits().length).toBe(1);
      expect(edits.pendingEdits()[0].new_text).toBe('A different sentence.');
    });

    it('has nothing to undo before anything is staged', () => {
      expect(edits.canUndo()).toBe(false);
      expect(edits.canRedo()).toBe(false);
    });
  });

  describe('the menu', () => {
    it('offers the text-block actions, and Discard only once one is staged', () => {
      api().onContextTarget('b0');
      expect(api().menuActionsFor('b0').map((a) => a.id)).toEqual(['edit-text', 'copy-text']);

      api().openEditor(BLOCK);
      api().draftText.set('Changed.');
      api().commitEditor();
      api().onContextTarget('b0');
      expect(api().menuActionsFor('b0').map((a) => a.id))
        .toEqual(['edit-text', 'copy-text', 'discard-edit']);
    });

    it('discards a staged edit from the menu', () => {
      api().openEditor(BLOCK);
      api().draftText.set('Changed.');
      api().commitEditor();
      api().onMenuAction({ action: 'discard-edit', itemId: 'b0' });
      expect(edits.pendingEdits().length).toBe(0);
    });

    it('offers the image actions in image mode', () => {
      api().mode.set('image');
      fixture.detectChanges();
      api().onContextTarget('i7');
      expect(api().menuActionsFor('i7').map((a) => a.id)).toEqual(['replace-image', 'delete-image']);
      expect(api().menuActionsFor('i7')[1].danger).toBe(true);
    });

    it('offers the link actions in link mode', () => {
      api().mode.set('link');
      fixture.detectChanges();
      api().onContextTarget('l2');
      expect(api().menuActionsFor('l2').map((a) => a.id)).toEqual(['copy-link', 'delete-link']);
    });

    it('offers nothing on empty page — Edit has no clipboard of its own', () => {
      api().onContextTarget(null);
      expect(api().menuActionsFor(null)).toEqual([]);
    });

    it('shows the selection, which used to be hard-bound to nothing', () => {
      api().mode.set('image');
      api().onSelect('i7');
      expect(api().selectedId()).toBe('i7');
    });
  });

  describe('deleting', () => {
    it('asks before deleting an image, as it always did', async () => {
      api().mode.set('image');
      fixture.detectChanges();
      api().onDeleteRequested('i7');
      await Promise.resolve();
      expect(asked).toEqual(['Delete this image?']);
    });

    it('asks before deleting a link, which it never used to', async () => {
      // `deleteLink` fired straight into a job with no confirmation at all,
      // unlike its image sibling — and there was no way to reach it by keyboard.
      await api().deleteLink(LINK);
      expect(asked).toEqual(['Delete the link to https://example.com?']);
    });
  });
});
