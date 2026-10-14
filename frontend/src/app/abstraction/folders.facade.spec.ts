import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { Folder } from '../core/models/models';
import { FoldersFacade } from './folders.facade';

describe('FoldersFacade', () => {
  let facade: FoldersFacade;
  let http: HttpTestingController;

  const FOLDERS: Folder[] = [
    { id: 'f1', name: 'Contracts', parent: null, created_at: '2026-08-01T00:00:00Z' },
    { id: 'f2', name: '2026', parent: 'f1', created_at: '2026-08-02T00:00:00Z' },
  ];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(FoldersFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('starts empty and holds the list once loaded', () => {
    expect(facade.folders()).toEqual([]);
    facade.load();
    http.expectOne('/api/folders/').flush(FOLDERS);
    expect(facade.folders()).toEqual(FOLDERS);
  });

  it('reloads the list after creating a folder, so the new one appears', () => {
    facade.create('Invoices', 'f1');
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/folders/');
    expect(post.request.body).toEqual({ name: 'Invoices', parent: 'f1' });
    post.flush({ id: 'f3', name: 'Invoices', parent: 'f1', created_at: '' });

    const reload = http.expectOne((r) => r.method === 'GET' && r.url === '/api/folders/');
    reload.flush([...FOLDERS, { id: 'f3', name: 'Invoices', parent: 'f1', created_at: '' }]);
    expect(facade.folders().map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
  });

  it('hands the delete back to the caller, cascade and all', () => {
    let done = false;
    facade.remove('f2', true).subscribe(() => { done = true; });
    const req = http.expectOne((r) => r.method === 'DELETE');
    expect(req.request.urlWithParams).toBe('/api/folders/f2/?cascade=trash');
    req.flush(null);
    expect(done).toBe(true);
  });
});
