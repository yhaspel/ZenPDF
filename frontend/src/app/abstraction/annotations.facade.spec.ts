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
    // …and the session is clean again: drawing a mark and removing it before
    // saving composes to nothing, so the "unsaved" badge and the beforeunload
    // guard must not stay armed over work that does not exist.
    expect(facade.dirty()).toBe(false);
    expect(facade.pendingChanges()).toBe(0);
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

  it('a reload drops only the drafts the last save actually sent', () => {
    loadWith([]);
    facade.add({ ...HIGHLIGHT, id: 'a1' });
    facade.save('doc-1', 2)!.subscribe();
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'))
      .flush({ id: 'job-1', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/job-1/'))
      .flush({ id: 'job-1', status: 'succeeded' });

    // Drawn *while* the save was in flight — it must survive the reload.
    facade.add({ ...HIGHLIGHT, id: 'a2' });

    facade.load('doc-1', 3);
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/annotations/'))
      .flush({ version: 3, annotations: [{ ...HIGHLIGHT, id: 'a1', author: 'Alice' }] });

    expect(facade.count()).toBe(2);
    expect(facade.ops()).toEqual([
      { action: 'add', annotation: { ...HIGHLIGHT, id: 'a2' } },
    ]);
  });

  it('a version conflict keeps every draft across the reload that follows', () => {
    // This is the path phase-03 §"Save model UX" specifies: no merge dialog,
    // reload and replay. A reload that wiped the drafts would lose the user's
    // work at exactly the moment the design promises not to.
    loadWith([]);
    facade.add({ ...HIGHLIGHT, id: 'a1' });
    facade.save('doc-1', 2)!.subscribe();
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'))
      .flush({ id: 'job-1', status: 'failed', error_code: 'version_conflict' });
    http.expectOne((r) => r.url.endsWith('/jobs/job-1/'))
      .flush({ id: 'job-1', status: 'failed', error_code: 'version_conflict' });

    facade.keepDraftsForReplay();
    facade.load('doc-1', 3);
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/annotations/'))
      .flush({ version: 3, annotations: [] });

    expect(facade.count()).toBe(1);
    expect(facade.dirty()).toBe(true);
    expect(facade.ops()).toEqual([
      { action: 'add', annotation: { ...HIGHLIGHT, id: 'a1' } },
    ]);
  });

  it('switching document resets the session', () => {
    loadWith([HIGHLIGHT]);
    facade.add({ ...HIGHLIGHT, id: 'a2' });
    facade.load('doc-2', 1);
    http.expectOne((r) => r.url.endsWith('/documents/doc-2/annotations/'))
      .flush({ version: 1, annotations: [] });
    // A draft belongs to one file; carrying it across would stamp it onto
    // whatever the user opened next.
    expect(facade.count()).toBe(0);
    expect(facade.ops()).toEqual([]);
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
  describe('undo and redo', () => {
    const box = (id: string, contents: string): Annotation => ({
      id, page: 0, type: 'free_text', rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.05 },
      contents, font_size: 12, width: 0,
    });

    it('takes back a draft, and puts it back', () => {
      expect(facade.canUndo()).toBe(false);
      facade.add(box('t1', 'hello'));
      expect(facade.count()).toBe(1);
      expect(facade.canUndo()).toBe(true);

      facade.undo();
      expect(facade.count()).toBe(0);
      expect(facade.canUndo()).toBe(false);
      expect(facade.canRedo()).toBe(true);

      facade.redo();
      expect(facade.count()).toBe(1);
      expect(facade.all()[0].contents).toBe('hello');
    });

    it('takes back an edit without taking back the shape', () => {
      facade.add(box('t1', ''));
      facade.update('t1', { contents: 'a whole sentence' });
      expect(facade.all()[0].contents).toBe('a whole sentence');

      facade.undo();
      expect(facade.count()).toBe(1);
      expect(facade.all()[0].contents).toBe('');
    });

    it('does not record an update that changes nothing', () => {
      // The on-page editor commits on blur *and* before the next gesture, and
      // a browser that fires blur for a removed element can report the same
      // sentence twice. The second report must not cost a ⌘Z that undoes
      // nothing visible.
      facade.add(box('t1', ''));
      facade.update('t1', { contents: 'once' });
      facade.update('t1', { contents: 'once' });
      facade.update('t1', { rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.05 } });
      expect(facade.all()[0].contents).toBe('once');

      facade.undo();
      expect(facade.all()[0].contents).toBe('');
      facade.undo();
      expect(facade.count()).toBe(0);
      expect(facade.canUndo()).toBe(false);
    });

    it('brings back something deleted, including one the file already had', () => {
      loadWith([HIGHLIGHT]);
      facade.remove('a1');
      expect(facade.count()).toBe(0);
      // A delete of a saved annotation is a real op — undoing it must un-arm it.
      expect(facade.ops()).toEqual([{ action: 'delete', annotation: { id: 'a1' } }]);

      facade.undo();
      expect(facade.count()).toBe(1);
      expect(facade.ops()).toEqual([]);
    });

    it('undoes a clear-all in one step', () => {
      loadWith([HIGHLIGHT]);
      facade.add(box('t1', 'note to self'));
      facade.removeAll();
      expect(facade.count()).toBe(0);

      facade.undo();
      expect(facade.count()).toBe(2);
    });

    it('drops the redo branch once something new is drawn', () => {
      facade.add(box('t1', 'one'));
      facade.undo();
      expect(facade.canRedo()).toBe(true);
      facade.add(box('t2', 'two'));
      expect(facade.canRedo()).toBe(false);
    });

    it('starts a new document with no history to walk into', () => {
      facade.add(box('t1', 'one'));
      facade.clear();
      expect(facade.canUndo()).toBe(false);
      expect(facade.canRedo()).toBe(false);
    });
  });

  it('learns the page width in points from the text layer', () => {
    expect(facade.pageWidthFor(0)).toBe(595);
    facade.loadWords('doc-1', 0, 2);
    http.expectOne((r) => r.url.endsWith('/documents/doc-1/text-words/')).flush({
      page: 0, width: 612, height: 792, rotation: 0, has_text: true, words: [],
    });
    // Letter, not A4 — a 12pt text box must not be drawn at A4's scale.
    expect(facade.pageWidthFor(0)).toBe(612);
    // …and one line of it is measured against the page's real height.
    expect(facade.pageHeightFor(0)).toBe(792);
    expect(facade.pageHeightFor(1)).toBe(842);
  });

  describe('the custom stamp', () => {
    let made: string[];
    let revoked: string[];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;

    beforeEach(() => {
      // jsdom has no blob-URL store, and what matters here is the bookkeeping:
      // one URL per stamp, and the one it replaces released.
      made = [];
      revoked = [];
      let n = 0;
      URL.createObjectURL = () => { const u = `blob:stamp-${++n}`; made.push(u); return u; };
      URL.revokeObjectURL = (u: string) => void revoked.push(u);
    });

    // The runner shares a process between spec files unless `--isolate`, so a
    // global left swapped out here would follow the thumbnail specs home.
    afterEach(() => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    });

    it('has nothing armed until something is uploaded', () => {
      expect(facade.stamp()).toBeNull();
    });

    it('holds the ref and a preview of the file that produced it', () => {
      facade.useStamp('ref-1', new Blob(['png'], { type: 'image/png' }));
      expect(facade.stamp()).toEqual({ ref: 'ref-1', preview: 'blob:stamp-1' });
    });

    it('releases the preview of the stamp it replaces', () => {
      facade.useStamp('ref-1', new Blob(['one']));
      facade.useStamp('ref-2', new Blob(['two']));
      expect(facade.stamp()!.ref).toBe('ref-2');
      expect(revoked).toEqual(['blob:stamp-1']);
      expect(made.length).toBe(2);
    });

    it('survives moving to another document', () => {
      // An `uploads/…` image is scoped to the principal, not to a file (§13):
      // stamping the same mark onto three documents is one upload, not three.
      facade.useStamp('ref-1', new Blob(['one']));
      facade.clear();
      expect(facade.stamp()).toEqual({ ref: 'ref-1', preview: 'blob:stamp-1' });
    });
  });
});
