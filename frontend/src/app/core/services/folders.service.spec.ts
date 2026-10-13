import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { FoldersService } from './folders.service';

describe('FoldersService', () => {
  let service: FoldersService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(FoldersService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists folders', () => {
    service.list().subscribe();
    const req = http.expectOne('/api/folders/');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('creates a top-level folder with an explicit null parent', () => {
    service.create('Contracts').subscribe();
    const req = http.expectOne('/api/folders/');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'Contracts', parent: null });
    req.flush({ id: 'f1', name: 'Contracts', parent: null, created_at: '' });
  });

  it('creates a nested folder under its parent', () => {
    service.create('2026', 'f1').subscribe();
    expect(http.expectOne('/api/folders/').request.body).toEqual({ name: '2026', parent: 'f1' });
  });

  it('deletes a folder, leaving its documents alone by default', () => {
    service.remove('f1').subscribe();
    const req = http.expectOne('/api/folders/f1/');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('asks for the contents to be trashed when told to cascade', () => {
    service.remove('f1', true).subscribe();
    const req = http.expectOne((r) => r.url === '/api/folders/f1/?cascade=trash'
      || r.urlWithParams === '/api/folders/f1/?cascade=trash');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });
});
