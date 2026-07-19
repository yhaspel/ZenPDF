import { HttpEventType, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { DocumentsService } from '../core/services/documents.service';
import { UploadFacade } from './upload.facade';

describe('UploadFacade', () => {
  const fake: Partial<DocumentsService> = {
    upload: () =>
      of(
        { type: HttpEventType.UploadProgress, loaded: 50, total: 100 } as never,
        new HttpResponse({ body: { id: 'd1' } }) as never,
      ),
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [UploadFacade, { provide: DocumentsService, useValue: fake }],
    });
  });

  it('reports progress and completes', () => {
    const facade = TestBed.inject(UploadFacade);
    let completed = 0;
    const file = new File([new Uint8Array([1, 2, 3])], 'x.pdf', { type: 'application/pdf' });
    facade.uploadFiles([file], null, () => (completed += 1));
    const item = facade.uploads()[0];
    expect(item.status).toBe('done');
    expect(item.progress).toBe(100);
    expect(completed).toBe(1);
  });
});
