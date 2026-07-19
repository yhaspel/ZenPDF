import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { ConfigService } from '../core/services/config.service';
import { DocListParams, DocumentsService } from '../core/services/documents.service';
import { DocumentsFacade } from './documents.facade';

describe('DocumentsFacade', () => {
  let captured: DocListParams | undefined;
  const fakeDocs: Partial<DocumentsService> = {
    list: (params?: DocListParams) => {
      captured = params;
      return of({ count: 1, next: null, previous: null, results: [{ id: 'd1' } as never] });
    },
  };
  const fakeConfig: Partial<ConfigService> = {
    usage: () => of({ period: '2026-07', storage: { used_bytes: 500, quota_bytes: 1000 }, counters: { sign_requests: 0, ocr_pages: 0, conversions: 0 } }),
  };

  beforeEach(() => {
    captured = undefined;
    TestBed.configureTestingModule({
      providers: [
        DocumentsFacade,
        { provide: DocumentsService, useValue: fakeDocs },
        { provide: ConfigService, useValue: fakeConfig },
      ],
    });
  });

  it('builds filter params and populates state', () => {
    const facade = TestBed.inject(DocumentsFacade);
    facade.q.set('report');
    facade.starred.set(true);
    facade.load();
    expect(captured?.q).toBe('report');
    expect(captured?.starred).toBe(true);
    expect(facade.documents().length).toBe(1);
  });

  it('computes storage percentage', () => {
    const facade = TestBed.inject(DocumentsFacade);
    facade.refreshUsage();
    expect(facade.storagePercent()).toBe(50);
  });
});
