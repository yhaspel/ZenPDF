import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { RedactReport } from '../core/models/models';
import { SecurityFacade } from './security.facade';

const RECT = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };

const REPORT: RedactReport = {
  count: 3,
  dry_run: true,
  matches: [
    { id: 'p0:0', page: 0, rect: RECT, text: 'ada@example.com' },
    { id: 'p0:1', page: 0, rect: RECT, text: 'bob@example.com' },
    { id: 'p1:2', page: 1, rect: RECT, text: 'carol@example.com' },
  ],
};

describe('SecurityFacade', () => {
  let facade: SecurityFacade;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(SecurityFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    facade.clear();
    facade.forget('doc-1');
  });

  function op() {
    return http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
  }

  function finish(job: object, id = 'j'): void {
    http.expectOne((r) => r.url.endsWith(`/jobs/${id}/`))
      .flush({ id, status: 'succeeded', ...job });
  }

  // ------------------------------------------------------------------ //
  // Session password
  // ------------------------------------------------------------------ //
  it('holds the session password in memory only', () => {
    facade.remember('doc-1', 'hunter2');
    expect(facade.passwordFor('doc-1')).toBe('hunter2');
    expect(facade.isUnlocked('doc-1')).toBe(true);
    // The whole point: nothing about it is written down.
    expect(JSON.stringify(localStorage)).not.toContain('hunter2');
    expect(document.cookie).not.toContain('hunter2');
  });

  it('sends the session password with every operation, so nothing re-prompts', () => {
    facade.remember('doc-1', 'hunter2');
    facade.sanitize('doc-1', 2, { metadata: true, javascript: false }).subscribe();
    const req = op();
    expect(req.request.body.document_password).toBe('hunter2');
    // Only the ticked items travel — the engine refuses an empty checklist.
    expect(req.request.body.params).toEqual({ metadata: true });
    req.flush({ id: 'j', status: 'succeeded' });
    finish({ result: { report: { total: 1 } } });
  });

  it('forgets the password when asked', () => {
    facade.remember('doc-1', 'hunter2');
    facade.forget('doc-1');
    expect(facade.passwordFor('doc-1')).toBe('');
    expect(facade.isUnlocked('doc-1')).toBe(false);
  });

  it('omits the password entirely when there is none', () => {
    facade.unlock('doc-1', 1, 'open-me').subscribe();
    const req = op();
    expect(req.request.body.document_password).toBeUndefined();
    expect(req.request.body.params).toEqual({ password: 'open-me' });
    req.flush({ id: 'j', status: 'succeeded' });
    finish({});
  });

  // ------------------------------------------------------------------ //
  // Protect
  // ------------------------------------------------------------------ //
  it('encrypts with the permission set', () => {
    facade.protect('doc-1', 1, {
      ownerPassword: 'owner', userPassword: 'open',
      permissions: { print: 'lowres', copy: false, modify: 'form_fill' },
    }).subscribe();
    const req = op();
    expect(req.request.body.type).toBe('encrypt');
    expect(req.request.body.params).toEqual({
      owner_password: 'owner',
      user_password: 'open',
      permissions: { print: 'lowres', copy: false, modify: 'form_fill' },
    });
    req.flush({ id: 'j', status: 'succeeded' });
    finish({});
  });

  it('leaves the open password out when it was not set', () => {
    facade.protect('doc-1', 1, { ownerPassword: 'owner' }).subscribe();
    const req = op();
    expect(req.request.body.params).toEqual({ owner_password: 'owner' });
    req.flush({ id: 'j', status: 'succeeded' });
    finish({});
  });

  // ------------------------------------------------------------------ //
  // Redact
  // ------------------------------------------------------------------ //
  it('previews without changing anything, and keeps every match by default', () => {
    facade.preview('doc-1', 1, [{ kind: 'preset', value: 'email' }], '', false).subscribe();
    const req = op();
    expect(req.request.body.params.dry_run).toBe(true);
    req.flush({ id: 'j', status: 'succeeded' });
    finish({ result: { report: REPORT } });

    expect(facade.report()?.count).toBe(3);
    expect(facade.keptIds()).toEqual(['p0:0', 'p0:1', 'p1:2']);
  });

  it('applies only the matches still ticked', () => {
    facade.preview('doc-1', 1, [{ kind: 'preset', value: 'email' }], '', false).subscribe();
    op().flush({ id: 'j', status: 'succeeded' });
    finish({ result: { report: REPORT } });

    facade.toggleMatch('p0:1');
    expect(facade.keptIds()).toEqual(['p0:0', 'p1:2']);

    facade.apply('doc-1', 1, {
      patterns: [{ kind: 'preset', value: 'email' }], searchText: '',
      matchCase: false, cleanCopy: true,
    }).subscribe();
    const req = op();
    expect(req.request.body.params.only).toEqual(['p0:0', 'p1:2']);
    expect(req.request.body.params.fork_clean_copy).toBe(true);
    expect(req.request.body.params.dry_run).toBeUndefined();
    req.flush({ id: 'j2', status: 'succeeded' });
    finish({ result: { documents: ['doc-2'] } }, 'j2');
  });

  it('sends an empty `only` when the user unticks everything', () => {
    // "None of these" is not "no filter". Omitting the key here meant the
    // engine redacted every match the user had just unticked.
    facade.preview('doc-1', 1, [{ kind: 'preset', value: 'email' }], '', false).subscribe();
    op().flush({ id: 'j', status: 'succeeded' });
    finish({ result: { report: REPORT } });
    for (const match of REPORT.matches) facade.toggleMatch(match.id);
    expect(facade.keptIds()).toEqual([]);

    facade.addArea(0, RECT);
    facade.apply('doc-1', 1, {
      patterns: [{ kind: 'preset', value: 'email' }], searchText: '',
      matchCase: false, cleanCopy: true,
    }).subscribe();
    const req = op();
    expect(req.request.body.params.only).toEqual([]);
    req.flush({ id: 'j2', status: 'succeeded' });
    finish({}, 'j2');
  });

  it('drops the review list when the search that produced it changes', () => {
    // Its ids are positions in one result set; against a different search they
    // identify different matches.
    facade.preview('doc-1', 1, [{ kind: 'preset', value: 'email' }], '', false).subscribe();
    op().flush({ id: 'j', status: 'succeeded' });
    finish({ result: { report: REPORT } });
    expect(facade.report()).not.toBeNull();

    facade.clearReview();
    expect(facade.report()).toBeNull();
    expect(facade.keptIds()).toEqual([]);
  });

  it('never reuses an area id after a removal', () => {
    // Reusing the index made deleting the newest area delete an older one too.
    facade.addArea(0, RECT);
    facade.addArea(0, RECT);
    const [first, second] = facade.areas();
    facade.removeArea(first.id);
    facade.addArea(0, RECT);
    const ids = facade.areas().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(second.id);
  });

  it('never sends an empty `only` for an area-only redaction', () => {
    // `only: []` would filter out every pattern match — and with no review list
    // there is nothing to filter, so the key must be absent, not empty.
    facade.addArea(0, RECT);
    facade.apply('doc-1', 1, {
      patterns: [], searchText: '', matchCase: true, cleanCopy: false,
    }).subscribe();
    const req = op();
    expect(req.request.body.params.only).toBeUndefined();
    expect(req.request.body.params.areas).toEqual([{ page: 0, rect: RECT }]);
    expect(req.request.body.params.fork_clean_copy).toBe(false);
    req.flush({ id: 'j', status: 'succeeded' });
    finish({});
  });

  it('knows whether there is anything to remove', () => {
    expect(facade.hasWork()).toBe(false);
    facade.addArea(0, RECT);
    expect(facade.hasWork()).toBe(true);
    facade.clear();
    expect(facade.hasWork()).toBe(false);
  });

  it('drops an area by id', () => {
    facade.addArea(0, RECT);
    facade.addArea(1, RECT);
    const [first] = facade.areas();
    facade.removeArea(first.id);
    expect(facade.areas().map((a) => a.page)).toEqual([1]);
  });

  it('clears busy when an operation fails outright', () => {
    let errored = false;
    facade.unlock('doc-1', 1, 'nope').subscribe({ error: () => (errored = true) });
    op().flush({ detail: 'boom' }, { status: 500, statusText: 'Server Error' });
    expect(errored).toBe(true);
    expect(facade.busy()).toBe(false);
  });
});
