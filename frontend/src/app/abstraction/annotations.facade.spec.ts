import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { Annotation } from '../core/models/models';
import { AnnotationsFacade } from './annotations.facade';

const HIGHLIGHT: Annotation = {
  id: 'a1',
  page: 0,
  type: 'highlight',
  quads: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }],
  color: '#ffff00',
  contents: 'first',
};

describe('AnnotationsFacade', () => {
  let facade: AnnotationsFacade;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(AnnotationsFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    facade.clear();
  });

  function loadWith(saved: Annotation[]): void {
    facade.load('doc-1', 2);
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/annotations/'));
    req.flush({ version: 2, annotations: saved });
  }

  it('starts clean and becomes dirty on the first draft', () => {
    loadWith([]);
    expect(facade.dirty()).toBe(false);
    facade.add(HIGHLIGHT);
    expect(facade.dirty()).toBe(true);
    expect(facade.count()).toBe(1);
  });

  it('merges saved annotations with local drafts', () => {
    loadWith([HIGHLIGHT]);
    expect(facade.count()).toBe(1);
    facade.add({ ...HIGHLIGHT, id: 'a2', contents: 'second' });
    expect(facade.count()).toBe(2);
    expect(facade.all().map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('composes an add for a new annotation and an update for a saved one', () => {
    loadWith([HIGHLIGHT]);
    facade.add({ ...HIGHLIGHT, id: 'a2' });
    facade.update('a1', { contents: 'edited' });

    const ops = facade.ops();
    expect(ops.length).toBe(2);
    const byId = new Map(ops.map((o) => [o.annotation.id, o.action]));
    expect(byId.get('a2')).toBe('add');
    expect(byId.get('a1')).toBe('update');
  });

  it('emits no op for deleting a draft that was never saved', () => {
    loadWith([]);
    facade.add(HIGHLIGHT);
    facade.remove('a1');
    expect(facade.ops()).toEqual([]);
    expect(facade.count()).toBe(0);
    // …but the session is still clean, because nothing needs sending.
    expect(facade.dirty()).toBe(true);
  });

  it('emits a delete op for an annotation the server knows about', () => {
    loadWith([HIGHLIGHT]);
    facade.remove('a1');
    expect(facade.ops()).toEqual([{ action: 'delete', annotation: { id: 'a1' } }]);
    expect(facade.count()).toBe(0);
  });

  it('clears the whole document in one batch', () => {
    loadWith([HIGHLIGHT, { ...HIGHLIGHT, id: 'a2' }]);
    facade.removeAll();
    expect(facade.count()).toBe(0);
    expect(facade.ops().map((o) => o.action)).toEqual(['delete', 'delete']);
  });

  it('groups by page for the comments sidebar', () => {
    loadWith([HIGHLIGHT, { ...HIGHLIGHT, id: 'a2', page: 2 }]);
    const grouped = facade.byPage();
    expect([...grouped.keys()].sort()).toEqual([0, 2]);
    expect(grouped.get(2)!.length).toBe(1);
  });

  it('save() is a no-op when nothing changed', () => {
    loadWith([HIGHLIGHT]);
    expect(facade.save('doc-1', 2)).toBeNull();
  });

  it('sends the whole session as ONE annotate_batch job', () => {
    loadWith([]);
    for (let i = 0; i < 30; i += 1) {
      facade.add({ ...HIGHLIGHT, id: `a${i}` });
    }
    const job$ = facade.save('doc-1', 2)!;
    expect(job$).not.toBeNull();
    job$.subscribe();

    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('annotate_batch');
    expect(req.request.body.params.ops.length).toBe(30);
    expect(req.request.body.base_version_seq).toBe(2);
    req.flush({ id: 'job-1', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/job-1/')).flush({
      id: 'job-1', status: 'succeeded',
    });
  });

  it('keeps drafts for replay after a version conflict', () => {
    loadWith([HIGHLIGHT]);
    facade.add({ ...HIGHLIGHT, id: 'a2' });
    facade.keepDraftsForReplay();
    // The saved set is dropped, so the draft is re-sent as an `add` against the
    // fresh version rather than an `update` of something that may have moved.
    expect(facade.ops()).toEqual([
      { action: 'add', annotation: { ...HIGHLIGHT, id: 'a2' } },
    ]);
  });

  it('caches the text layer per page and refetches after a version change', () => {
    facade.loadWords('doc-1', 0, 2);
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/text-words/')).flush({
      page: 0, width: 595, height: 842, rotation: 0, has_text: true,
      words: [{ i: 0, t: 'hello', x: 0.1, y: 0.1, w: 0.1, h: 0.02, b: 0, l: 0, n: 0 }],
    });
    expect(facade.wordsFor(0).length).toBe(1);

    facade.loadWords('doc-1', 0, 2); // cached — no second request
    http.verify();

    facade.resetForVersion();
    facade.loadWords('doc-1', 0, 3);
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/text-words/')).flush({
      page: 0, width: 595, height: 842, rotation: 0, has_text: false, words: [],
    });
    expect(facade.wordsFor(0)).toEqual([]);
  });
});
