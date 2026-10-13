import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';

import { AuthFacade } from '../../abstraction/auth.facade';
import { ConvertFacade } from '../../abstraction/convert.facade';
import { DocumentsFacade } from '../../abstraction/documents.facade';
import { FoldersFacade } from '../../abstraction/folders.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { UploadFacade, UploadItem } from '../../abstraction/upload.facade';
import { ClaimSummary, DocumentModel, Folder, Job, Usage } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ThumbnailScheduler } from '../../core/services/thumbnail-scheduler';
import { ConfirmService } from '../../shared/confirm.service';
import { ToastService } from '../../shared/toast.service';
import { Dashboard } from './dashboard';

@Component({ template: '' })
class Blank {}

/**
 * The library (design contract §4 dashboard).
 *
 * `undeletable.spec.ts` covers the facade half of one card. This file covers
 * the screen: that it renders what the facade holds and nothing else, that
 * every filter in the sidebar changes the query and reloads, that the three
 * card actions reach the facade with the right id — trash only after the
 * confirm, restore straight away — that a dropped file goes down the upload
 * path and a dropped Word file down the conversion path, and that the two
 * transient rows (uploading, converting) appear and disappear when they
 * should. The ad surfaces are pinned too: the rail and the one inline card
 * after the third file, never more.
 */
describe('Dashboard', () => {
  let fixture: ComponentFixture<Dashboard>;
  let documents: ReturnType<typeof signal<DocumentModel[]>>;
  let loading: ReturnType<typeof signal<boolean>>;
  let loadingMore: ReturnType<typeof signal<boolean>>;
  let hasMore: ReturnType<typeof signal<boolean>>;
  let total: ReturnType<typeof signal<number>>;
  let usage: ReturnType<typeof signal<Usage | null>>;
  let purgeErrors: ReturnType<typeof signal<Record<string, string>>>;
  let folders: ReturnType<typeof signal<Folder[]>>;
  let uploads: ReturnType<typeof signal<UploadItem[]>>;
  let lastClaim: ReturnType<typeof signal<ClaimSummary | null>>;
  let docs: {
    q: ReturnType<typeof signal<string>>;
    folder: ReturnType<typeof signal<string | null>>;
    starred: ReturnType<typeof signal<boolean>>;
    trashed: ReturnType<typeof signal<boolean>>;
    load: ReturnType<typeof vi.fn>;
    loadMore: ReturnType<typeof vi.fn>;
    trash: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    purge: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    toggleStar: ReturnType<typeof vi.fn>;
  };
  let createFolder: ReturnType<typeof vi.fn>;
  let uploadFiles: ReturnType<typeof vi.fn>;
  let retryWithRepair: ReturnType<typeof vi.fn>;
  let importFile: ReturnType<typeof vi.fn>;
  let importImages: ReturnType<typeof vi.fn>;
  let importUrl: ReturnType<typeof vi.fn>;
  let clearLastClaim: ReturnType<typeof vi.fn>;
  let download: ReturnType<typeof vi.fn>;

  function doc(partial: Partial<DocumentModel> & { id: string }): DocumentModel {
    return {
      title: partial.id, status: 'ready', page_count: 2, size_bytes: 2048, is_encrypted: false,
      starred: false, folder: null, metadata: {}, current_version: null, last_opened_at: null,
      trashed_at: null, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z',
      has_sign_requests: false,
      ...partial,
    };
  }

  function job(partial: Partial<Job>): Job {
    return {
      id: 'j1', type: 'convert_from', document: null, status: 'succeeded', progress: 100,
      params: {}, base_version_seq: null, error_code: '', error_message: '', error_details: {},
      result: null, created_at: '2026-10-01T10:00:00Z', started_at: null, finished_at: null,
      ...partial,
    };
  }

  function file(name: string, type: string): File {
    return new File(['x'], name, { type });
  }

  function render(initial: DocumentModel[] = []): HTMLElement {
    documents = signal(initial);
    loading = signal(false);
    loadingMore = signal(false);
    hasMore = signal(false);
    total = signal(initial.length);
    usage = signal<Usage | null>(null);
    purgeErrors = signal<Record<string, string>>({});
    folders = signal<Folder[]>([]);
    uploads = signal<UploadItem[]>([]);
    lastClaim = signal<ClaimSummary | null>(null);
    docs = {
      q: signal(''),
      folder: signal<string | null>(null),
      starred: signal(false),
      trashed: signal(false),
      load: vi.fn(),
      loadMore: vi.fn(),
      trash: vi.fn(),
      restore: vi.fn(),
      purge: vi.fn(),
      rename: vi.fn(),
      toggleStar: vi.fn(),
    };
    createFolder = vi.fn();
    uploadFiles = vi.fn();
    retryWithRepair = vi.fn();
    importFile = vi.fn(() => of(job({})));
    importImages = vi.fn(() => of(job({})));
    importUrl = vi.fn(() => of(job({})));
    clearLastClaim = vi.fn();
    download = vi.fn(() => of(new Blob(['pdf'])));

    TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', component: Blank }]),
        {
          provide: DocumentsFacade,
          useValue: {
            ...docs,
            documents, loading, loadingMore, hasMore, total, usage, purgeErrors,
            storagePercent: signal(0),
          },
        },
        { provide: FoldersFacade, useValue: { folders, load: vi.fn(), create: createFolder } },
        { provide: UploadFacade, useValue: { uploads, uploadFiles, retryWithRepair } },
        { provide: AuthFacade, useValue: { lastClaim, clearLastClaim } },
        { provide: ConvertFacade, useValue: { importFile, importImages, importUrl } },
        { provide: JobsFacade, useValue: { dispatch: (c$: Observable<Job>) => c$ } },
        {
          provide: DocumentsService,
          useValue: {
            download,
            crossOperation: vi.fn(() => of(job({ type: 'merge', result: { documents: ['merged-1'] } }))),
            thumbnailBlob: () => new Observable<Blob>(() => { /* never */ }),
          },
        },
        { provide: ThumbnailScheduler, useValue: { holdFor: () => 0, isRefusal: () => false } },
      ],
    });
    fixture = TestBed.createComponent(Dashboard);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const q = <T extends HTMLElement>(sel: string) =>
    fixture.nativeElement.querySelector(sel) as T | null;
  const all = (sel: string) => [...fixture.nativeElement.querySelectorAll(sel)] as HTMLElement[];
  const toasts = () => TestBed.inject(ToastService).toasts();
  const confirm = () => TestBed.inject(ConfirmService);

  function type(sel: string, value: string): void {
    const input = q<HTMLInputElement>(sel)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  /** `[ngModel]` writes the DOM value on a microtask, so a value check waits. */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function openMenu(index = 0): void {
    all('[data-test="doc-menu"]')[index].click();
    fixture.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  describe('the list', () => {
    it('loads documents and folders on arrival', () => {
      render();
      expect(docs.load).toHaveBeenCalledTimes(1);
      expect(TestBed.inject(FoldersFacade).load).toHaveBeenCalledTimes(1);
    });

    it('renders one card per document, with its title, page count and size', () => {
      const el = render([
        doc({ id: 'a', title: 'Lease', page_count: 12, size_bytes: 3 * 1048576 }),
        doc({ id: 'b', title: 'Invoice', page_count: 1, size_bytes: 512 }),
      ]);
      const cards = all('[data-test="doc-card"]');
      expect(cards.length).toBe(2);
      expect(cards[0].querySelector('[data-test="doc-title"]')!.textContent!.trim()).toBe('Lease');
      expect(cards[0].textContent).toContain('12 pages');
      expect(cards[0].textContent).toContain('3.0 MB');
      expect(cards[1].textContent).toContain('512 B');
      expect(el.querySelector('[data-test="doc-count"]')!.textContent!.replace(/\s+/g, ' '))
        .toContain('Showing 2 of 2');
    });

    it('shows the empty sheet when there is nothing, worded for the trash too', () => {
      const el = render();
      expect(el.querySelector('[data-test="empty-state"]')!.textContent).toContain('No documents yet');
      expect(el.querySelector('[data-test="empty-state"]')!.textContent).toContain('Upload a PDF');
      expect(q('[data-test="doc-grid"]')).toBeNull();

      docs.trashed.set(true);
      fixture.detectChanges();
      expect(el.querySelector('[data-test="empty-state"]')!.textContent).toContain('Trash is empty');
    });

    it('shows a spinner, not an empty state, while the first page loads', () => {
      render();
      loading.set(true);
      fixture.detectChanges();
      expect(q('app-spinner')).not.toBeNull();
      expect(q('[data-test="empty-state"]')).toBeNull();
    });

    it('offers Load more only while the server says there is more', () => {
      render([doc({ id: 'a' })]);
      expect(q('[data-test="load-more"]')).toBeNull();
      hasMore.set(true);
      fixture.detectChanges();
      q('[data-test="load-more"]')!.click();
      expect(docs.loadMore).toHaveBeenCalledTimes(1);
      loadingMore.set(true);
      fixture.detectChanges();
      expect(q<HTMLButtonElement>('[data-test="load-more"]')!.disabled).toBe(true);
    });

    it('opens a document when its thumbnail is pressed', () => {
      render([doc({ id: 'abc' })]);
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('[data-test="open-doc"]')!.click();
      expect(navigate).toHaveBeenCalledWith(['/app/doc', 'abc']);
    });

    it('reads the storage meter from the facade', () => {
      const el = render();
      expect(q('[data-test="storage-meter"]')).toBeNull();
      usage.set({
        period: '', principal: 'user', tier: 'free',
        storage: { used_bytes: 5 * 1048576, quota_bytes: 100 * 1048576 },
        counters: { sign_requests: 0, ocr_pages: 0, conversions: 0, heavy_ops: 0, metered_ops_this_hour: 0 },
        limits: {} as Usage['limits'],
      });
      fixture.detectChanges();
      expect(el.querySelector('[data-test="storage-meter"]')!.textContent!.replace(/\s+/g, ' '))
        .toContain('5.0 / 100 MB');
    });
  });

  describe('filters', () => {
    it('reloads with the typed query on Enter', () => {
      render();
      docs.load.mockClear();
      type('[data-test="search"]', 'lease');
      expect(docs.q()).toBe('lease');
      expect(docs.load).not.toHaveBeenCalled();
      q('[data-test="search"]')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
      expect(docs.load).toHaveBeenCalledTimes(1);
    });

    it('lists the folders and switches between them', () => {
      folders = signal<Folder[]>([]);
      render();
      folders.set([
        { id: 'f1', name: 'Tax', parent: null, created_at: '' },
        { id: 'f2', name: 'Work', parent: null, created_at: '' },
      ]);
      fixture.detectChanges();
      const items = all('[data-test="folder-item"]');
      expect(items.map((b) => b.textContent!.trim())).toEqual(['Tax', 'Work']);

      docs.load.mockClear();
      items[1].click();
      expect(docs.folder()).toBe('f2');
      expect(docs.load).toHaveBeenCalledTimes(1);
      fixture.detectChanges();
      expect(items[1].classList).toContain('bg-accent-surface');

      q('[data-test="folder-all"]')!.click();
      expect(docs.folder()).toBeNull();
      expect(docs.load).toHaveBeenCalledTimes(2);
    });

    it('creates a folder from the trimmed name and clears the box, ignoring blanks', async () => {
      render();
      type('[data-test="new-folder-input"]', '   ');
      q('[data-test="add-folder"]')!.click();
      expect(createFolder).not.toHaveBeenCalled();

      type('[data-test="new-folder-input"]', '  Receipts ');
      q('[data-test="add-folder"]')!.click();
      expect(createFolder).toHaveBeenCalledWith('Receipts');
      await settle();
      expect(q<HTMLInputElement>('[data-test="new-folder-input"]')!.value).toBe('');
    });

    it('toggles the starred filter and reloads', () => {
      render();
      docs.load.mockClear();
      q('[data-test="star-filter"]')!.click();
      expect(docs.starred()).toBe(true);
      expect(docs.load).toHaveBeenCalledTimes(1);
      q('[data-test="star-filter"]')!.click();
      expect(docs.starred()).toBe(false);
    });

    it('entering the trash reloads, drops the selection and hides the dropzone', () => {
      render([doc({ id: 'a' }), doc({ id: 'b' })]);
      all('[data-test="select-doc"]').forEach((cb) => cb.click());
      fixture.detectChanges();
      expect(q('[data-test="merge-btn"]')).not.toBeNull();
      expect(q('app-upload-dropzone')).not.toBeNull();

      docs.load.mockClear();
      q('[data-test="trash-toggle"]')!.click();
      fixture.detectChanges();
      expect(docs.trashed()).toBe(true);
      expect(docs.load).toHaveBeenCalledTimes(1);
      expect(q('[data-test="merge-btn"]')).toBeNull();
      expect(q('app-upload-dropzone')).toBeNull();
      expect(q('[data-test="import-url-row"]')).toBeNull();
      expect(q('[data-test="select-doc"]')).toBeNull();
    });
  });

  describe('card actions', () => {
    it('stars through the facade with the document itself', () => {
      render([doc({ id: 'a' })]);
      q('[data-test="star-toggle"]')!.click();
      expect(docs.toggleStar).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    });

    it('offers rename, download and trash outside the trash; restore and purge inside it', () => {
      render([doc({ id: 'a' })]);
      openMenu();
      expect(q('[data-test="rename"]')).not.toBeNull();
      expect(q('[data-test="download"]')).not.toBeNull();
      expect(q('[data-test="trash"]')).not.toBeNull();
      expect(q('[data-test="restore"]')).toBeNull();

      docs.trashed.set(true);
      fixture.detectChanges();
      expect(q('[data-test="trash"]')).toBeNull();
      expect(q('[data-test="restore"]')).not.toBeNull();
      expect(q('[data-test="purge"]')).not.toBeNull();
    });

    it('trashes only after the confirm says yes, with the right id', async () => {
      render([doc({ id: 'a', title: 'Lease' })]);
      openMenu();
      q('[data-test="trash"]')!.click();
      expect(confirm().current()!.message).toContain('“Lease”');
      expect(docs.trash).not.toHaveBeenCalled();

      confirm().answer(false);
      await fixture.whenStable();
      expect(docs.trash).not.toHaveBeenCalled();

      openMenu();
      q('[data-test="trash"]')!.click();
      confirm().answer(true);
      await fixture.whenStable();
      expect(docs.trash).toHaveBeenCalledWith('a');
      expect(toasts().map((t) => t.message)).toContain('Moved to trash');
    });

    it('restores straight away — nothing is lost by it', () => {
      render([doc({ id: 'b' })]);
      docs.trashed.set(true);
      fixture.detectChanges();
      openMenu();
      q('[data-test="restore"]')!.click();
      expect(docs.restore).toHaveBeenCalledWith('b');
      expect(toasts().map((t) => t.message)).toContain('Restored');
    });

    it('purges only after the confirm, and never offers it for a signed document', async () => {
      render([doc({ id: 'c' }), doc({ id: 'signed', has_sign_requests: true })]);
      docs.trashed.set(true);
      fixture.detectChanges();

      openMenu(1);
      expect(q('[data-test="purge"]')).toBeNull();
      expect(all('[data-test="undeletable"]').length).toBe(1);
      expect(q('[data-test="undeletable"]')!.textContent).toContain('cannot be deleted');

      openMenu(0);
      q('[data-test="purge"]')!.click();
      expect(confirm().current()!.confirmLabel).toBe('Delete forever');
      confirm().answer(true);
      await fixture.whenStable();
      expect(docs.purge).toHaveBeenCalledWith('c');
    });

    it("quotes the server's own refusal over the standing caption", () => {
      render([doc({ id: 'c' })]);
      docs.trashed.set(true);
      purgeErrors.set({ c: 'The server said no, in its own words.' });
      fixture.detectChanges();
      expect(q('[data-test="undeletable"]')!.textContent!.trim())
        .toBe('The server said no, in its own words.');
    });

    it('renames in place and commits the trimmed title on Enter', async () => {
      render([doc({ id: 'a', title: 'Old' })]);
      openMenu();
      q('[data-test="rename"]')!.click();
      await settle();
      expect(q<HTMLInputElement>('[data-test="rename-input"]')!.value).toBe('Old');
      type('[data-test="rename-input"]', '  New title ');
      q('[data-test="rename-input"]')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
      fixture.detectChanges();
      expect(docs.rename).toHaveBeenCalledWith('a', 'New title');
      expect(q('[data-test="rename-input"]')).toBeNull();
    });

    it('does not rename to an empty title', () => {
      render([doc({ id: 'a', title: 'Old' })]);
      openMenu();
      q('[data-test="rename"]')!.click();
      fixture.detectChanges();
      type('[data-test="rename-input"]', '   ');
      q('[data-test="rename-input"]')!.dispatchEvent(new Event('blur'));
      expect(docs.rename).not.toHaveBeenCalled();
    });

    it('downloads the document by id and says so when it fails', () => {
      render([doc({ id: 'a', title: 'Lease' })]);
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = () => 'blob:x';
      try {
        openMenu();
        q('[data-test="download"]')!.click();
        expect(download).toHaveBeenCalledWith('a');
        expect(click).toHaveBeenCalledTimes(1);

        download.mockReturnValue(throwError(() => new Error('403')));
        openMenu();
        q('[data-test="download"]')!.click();
        expect(toasts().map((t) => [t.type, t.message])).toContainEqual(['error', 'Download failed']);
      } finally {
        URL.createObjectURL = realCreate;
        vi.restoreAllMocks();
      }
    });
  });

  describe('selection and merge', () => {
    it('shows Merge only from two selected, and sends exactly those ids', () => {
      render([doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })]);
      const boxes = all('[data-test="select-doc"]');
      boxes[0].click();
      fixture.detectChanges();
      expect(q('[data-test="merge-btn"]')).toBeNull();
      boxes[2].click();
      fixture.detectChanges();
      expect(q('[data-test="merge-btn"]')!.textContent).toContain('Merge 2');

      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('[data-test="merge-btn"]')!.click();
      expect(TestBed.inject(DocumentsService).crossOperation).toHaveBeenCalledWith({
        type: 'merge', params: { document_ids: ['a', 'c'] },
      });
      expect(toasts().map((t) => t.message)).toContain('Documents merged');
      expect(navigate).toHaveBeenCalledWith(['/app/doc', 'merged-1']);
      fixture.detectChanges();
      expect(q('[data-test="merge-btn"]')).toBeNull();
    });
  });

  describe('uploads and imports', () => {
    it('sends PDFs to the upload facade, into the current folder', () => {
      render();
      docs.folder.set('f9');
      const pdf = file('a.pdf', 'application/pdf');
      fixture.debugElement.query((de) => de.name === 'app-upload-dropzone')
        .triggerEventHandler('filesPicked', [pdf]);
      expect(uploadFiles).toHaveBeenCalledTimes(1);
      expect(uploadFiles.mock.calls[0][0]).toEqual([pdf]);
      expect(uploadFiles.mock.calls[0][1]).toBe('f9');
      expect(importFile).not.toHaveBeenCalled();
    });

    it('reloads and confirms once an upload completes', () => {
      render();
      fixture.debugElement.query((de) => de.name === 'app-upload-dropzone')
        .triggerEventHandler('filesPicked', [file('a.pdf', 'application/pdf')]);
      docs.load.mockClear();
      (uploadFiles.mock.calls[0][2] as () => void)();
      expect(docs.load).toHaveBeenCalledTimes(1);
      expect(toasts().map((t) => t.message)).toContain('Uploaded');
    });

    it('converts a Word file on its own and several images into one document', () => {
      render();
      const word = file('cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const img1 = file('a.jpg', 'image/jpeg');
      const img2 = file('b.png', 'image/png');
      fixture.debugElement.query((de) => de.name === 'app-upload-dropzone')
        .triggerEventHandler('filesPicked', [word, img1, img2]);
      expect(uploadFiles).not.toHaveBeenCalled();
      expect(importFile).toHaveBeenCalledTimes(1);
      expect(importFile).toHaveBeenCalledWith(word);
      expect(importImages).toHaveBeenCalledWith([img1, img2]);
    });

    it('converts a lone image on its own rather than as a one-image batch', () => {
      render();
      const img = file('a.jpg', 'image/jpeg');
      fixture.debugElement.query((de) => de.name === 'app-upload-dropzone')
        .triggerEventHandler('filesPicked', [img]);
      expect(importImages).not.toHaveBeenCalled();
      expect(importFile).toHaveBeenCalledWith(img);
    });

    it('shows the converting row until the job lands, then reloads', () => {
      render();
      let settle!: (j: Job) => void;
      importFile.mockReturnValue(new Observable<Job>((sub) => { settle = (j) => { sub.next(j); sub.complete(); }; }));
      fixture.debugElement.query((de) => de.name === 'app-upload-dropzone')
        .triggerEventHandler('filesPicked', [file('cv.docx', 'application/msword')]);
      fixture.detectChanges();
      expect(q('[data-test="importing-list"]')!.textContent).toContain('cv.docx');

      docs.load.mockClear();
      settle(job({ status: 'succeeded' }));
      fixture.detectChanges();
      expect(q('[data-test="importing-list"]')).toBeNull();
      expect(docs.load).toHaveBeenCalledTimes(1);
      expect(toasts().map((t) => t.message)).toContain('Converted to PDF');
    });

    it("reports a failed conversion with the job's own sentence", () => {
      render();
      importFile.mockReturnValue(of(job({ status: 'failed', error_message: 'Not a document we can read.' })));
      fixture.debugElement.query((de) => de.name === 'app-upload-dropzone')
        .triggerEventHandler('filesPicked', [file('x.bin', 'application/octet-stream')]);
      fixture.detectChanges();
      expect(q('[data-test="importing-list"]')).toBeNull();
      expect(toasts().map((t) => [t.type, t.message]))
        .toContainEqual(['error', 'Not a document we can read.']);
    });

    it('saves a web address as a PDF and clears the box on success', async () => {
      render();
      expect(q<HTMLButtonElement>('[data-test="import-url-btn"]')!.disabled).toBe(true);
      type('[data-test="import-url"]', ' https://example.com/page ');
      expect(q<HTMLButtonElement>('[data-test="import-url-btn"]')!.disabled).toBe(false);
      q('[data-test="import-url-btn"]')!.click();
      expect(importUrl).toHaveBeenCalledWith('https://example.com/page');
      await settle();
      expect(q<HTMLInputElement>('[data-test="import-url"]')!.value).toBe('');
    });

    it('rows only uploads in flight or failed — a finished one is its card', () => {
      const f = file('a.pdf', 'application/pdf');
      render();
      uploads.set([
        { id: 'u1', name: 'a.pdf', progress: 40, status: 'uploading', file: f },
        { id: 'u2', name: 'b.pdf', progress: 100, status: 'done', file: f },
        { id: 'u3', name: 'c.pdf', progress: 0, status: 'error', error: 'Too big.', file: f },
      ]);
      fixture.detectChanges();
      const list = q('[data-test="upload-list"]')!;
      expect(list.textContent).toContain('a.pdf');
      expect(list.textContent).toContain('40%');
      expect(list.textContent).not.toContain('b.pdf');
      expect(q('[data-test="upload-error"]')!.textContent).toContain('Too big.');
    });

    it('offers repair for a repairable failure and retries through the facade', () => {
      const f = file('broken.pdf', 'application/pdf');
      render();
      const item: UploadItem = { id: 'u1', name: 'broken.pdf', progress: 0, status: 'repairable', file: f };
      uploads.set([item]);
      docs.folder.set('f2');
      fixture.detectChanges();
      q('[data-test="repair-btn"]')!.click();
      expect(retryWithRepair).toHaveBeenCalledTimes(1);
      expect(retryWithRepair.mock.calls[0][0]).toBe(item);
      expect(retryWithRepair.mock.calls[0][1]).toBe('f2');
    });

    it('wears the "Just uploaded" stamp on the fresh card, then takes it off', () => {
      vi.useFakeTimers();
      try {
        render();
        fixture.debugElement.query((de) => de.name === 'app-upload-dropzone')
          .triggerEventHandler('filesPicked', [file('a.pdf', 'application/pdf')]);
        (uploadFiles.mock.calls[0][2] as () => void)();
        documents.set([doc({ id: 'fresh', created_at: new Date().toISOString() })]);
        fixture.detectChanges();
        expect(q('[data-test="doc-card"] .stamp')!.textContent).toContain('Just uploaded');

        vi.advanceTimersByTime(6500);
        fixture.detectChanges();
        expect(q('[data-test="doc-card"] .stamp')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not stamp a document that merely arrived on a reload', () => {
      render();
      documents.set([doc({ id: 'old', created_at: new Date().toISOString() })]);
      fixture.detectChanges();
      expect(q('[data-test="doc-card"] .stamp')).toBeNull();
    });
  });

  describe('the claim banner', () => {
    it('shows what signup rescued and can be dismissed', () => {
      render();
      expect(q('[data-test="claim-banner"]')).toBeNull();
      lastClaim.set({ documents: 3, jobs: 0, bytes: 0 } as ClaimSummary);
      fixture.detectChanges();
      expect(q('[data-test="claim-banner"]')!.textContent!.replace(/\s+/g, ' '))
        .toContain('3 files from your guest session are now saved');
      q('[data-test="claim-banner"] button')!.click();
      expect(clearLastClaim).toHaveBeenCalledTimes(1);
    });

    it('gets the grammar right for one file', () => {
      render();
      lastClaim.set({ documents: 1, jobs: 0, bytes: 0 } as ClaimSummary);
      fixture.detectChanges();
      expect(q('[data-test="claim-banner"]')!.textContent!.replace(/\s+/g, ' '))
        .toContain('1 file from your guest session is now saved');
    });
  });

  describe('ads', () => {
    it('declares the rail, and one inline card after the third file, never more', () => {
      render([doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })]);
      const names = () => all('app-ad-slot').map((s) => s.getAttribute('name'));
      expect(names()).toEqual(['dashboard-rail']);

      documents.set(Array.from({ length: 10 }, (_, i) => doc({ id: `d${i}` })));
      fixture.detectChanges();
      expect(names()).toEqual(['dashboard-inline', 'dashboard-rail']);
      // Fourth position in the grid: after a, b, c.
      const grid = [...q('[data-test="doc-grid"]')!.children];
      expect(grid[3].getAttribute('data-test')).toBe('ad-card-mobile');
    });
  });
});
