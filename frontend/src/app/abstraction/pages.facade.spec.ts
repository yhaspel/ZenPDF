import { TestBed } from '@angular/core/testing';

import { DocumentsService } from '../core/services/documents.service';
import { JobsFacade } from './jobs.facade';
import { PagesFacade } from './pages.facade';

describe('PagesFacade', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        PagesFacade,
        { provide: DocumentsService, useValue: {} },
        { provide: JobsFacade, useValue: {} },
      ],
    });
  });

  it('toggles and range-selects pages', () => {
    const facade = TestBed.inject(PagesFacade);
    facade.toggle(0, false);
    expect(facade.isSelected(0)).toBe(true);
    facade.toggle(2, true);
    expect(facade.selectedSorted()).toEqual([0, 2]);
    facade.selectRange(4); // anchor was 2
    expect(facade.selectedSorted()).toEqual([2, 3, 4]);
    facade.clear();
    expect(facade.selection().size).toBe(0);
  });
});
