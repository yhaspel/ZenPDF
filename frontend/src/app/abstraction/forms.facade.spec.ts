import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { FormField, FormModel } from '../core/models/models';
import { FormsFacade } from './forms.facade';

function field(over: Partial<FormField> = {}): FormField {
  return {
    name: 'full_name',
    type: 'text',
    page: 0,
    rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.03 },
    value: '',
    default: '',
    align: 'left',
    font_size: 0,
    options: [],
    flags: { required: false, readonly: false, multiline: false, password: false },
    max_len: 0,
    widgets: [{ page: 0, rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, on_value: '' }],
    ...over,
  };
}

const MODEL: FormModel = {
  has_form: true,
  is_xfa: false,
  fields: [
    field(),
    field({ name: 'agree', type: 'checkbox', value: '', options: ['Yes'] }),
  ],
};

describe('FormsFacade', () => {
  let facade: FormsFacade;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(FormsFacade);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => facade.reset());

  function load(model: FormModel = MODEL, docId = 'doc-1'): void {
    facade.load(docId, 1);
    http.expectOne((r) => r.url.endsWith(`/documents/${docId}/form/`)).flush(model);
  }

  it('loads the read model', () => {
    load();
    expect(facade.hasForm()).toBe(true);
    expect(facade.isXfa()).toBe(false);
    expect(facade.fields().length).toBe(2);
  });

  it('reports an XFA document so the UI can warn', () => {
    load({ ...MODEL, is_xfa: true });
    expect(facade.isXfa()).toBe(true);
  });

  it('only sends the values that actually changed', () => {
    load();
    expect(facade.dirty()).toBe(false);

    facade.setValue('full_name', 'Ada');
    expect(facade.changed()).toEqual({ full_name: 'Ada' });

    // Typing the original back is not a change — sending it would mint a
    // version that says "Form filled" and alter nothing.
    facade.setValue('full_name', '');
    expect(facade.dirty()).toBe(false);
  });

  it('ignores viewer fields the read model does not know', () => {
    // PDF.js reports the XFA layer's own field names too, and `fill_form`
    // fails the whole job on a single unknown name.
    load();
    facade.syncFromViewer({ full_name: 'Grace', 'form1[0].mystery[0]': 'x' });
    expect(facade.changed()).toEqual({ full_name: 'Grace' });
  });

  it('treats a checkbox as a boolean on both sides', () => {
    load();
    facade.syncFromViewer({ agree: true });
    expect(facade.changed()).toEqual({ agree: true });

    facade.setValue('agree', false);
    expect(facade.dirty()).toBe(false);
  });

  it('saves every changed field as ONE fill_form job', () => {
    load();
    facade.setValue('full_name', 'Ada');
    facade.setValue('agree', true);

    facade.saveFill('doc-1', 3)!.subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('fill_form');
    expect(req.request.body.params.values).toEqual({ full_name: 'Ada', agree: true });
    expect(req.request.body.params.flatten_after).toBeUndefined();
    expect(req.request.body.base_version_seq).toBe(3);
    req.flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({ id: 'j', status: 'succeeded' });
  });

  it('saveFill is a no-op with nothing typed', () => {
    load();
    expect(facade.saveFill('doc-1', 1)).toBeNull();
  });

  it('asks for flatten_after when saving and flattening together', () => {
    load();
    facade.setValue('full_name', 'Ada');
    facade.saveFill('doc-1', 1, true)!.subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.params.flatten_after).toBe(true);
    req.flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({ id: 'j', status: 'succeeded' });
  });

  it('flattens an untouched form through the flatten op', () => {
    load();
    facade.flatten('doc-1', 1).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('flatten');
    expect(req.request.body.params).toEqual({ what: 'form' });
    req.flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({ id: 'j', status: 'succeeded' });
  });

  it('switching document drops the previous form', () => {
    load();
    facade.setValue('full_name', 'Ada');
    load({ has_form: false, is_xfa: false, fields: [] }, 'doc-2');
    expect(facade.dirty()).toBe(false);
    expect(facade.hasForm()).toBe(false);
  });

  describe('builder', () => {
    it('suggests a name nothing else is using', () => {
      load();
      expect(facade.suggestName('text')).toBe('text_1');
      facade.stageAdd({ name: 'text_1', type: 'text', page: 0 });
      expect(facade.suggestName('text')).toBe('text_2');
    });

    it('commits the whole session as ONE edit_form_fields_batch job', () => {
      load();
      facade.stageAdd({ name: 'a', type: 'text', page: 0 });
      facade.stageAdd({ name: 'b', type: 'checkbox', page: 0 });
      facade.stageDelete('full_name');

      facade.commitFields('doc-1', 2)!.subscribe();
      const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
      expect(req.request.body.type).toBe('edit_form_fields_batch');
      expect(req.request.body.params.ops.map((o: { action: string }) => o.action))
        .toEqual(['add', 'add', 'delete']);
      req.flush({ id: 'j', status: 'succeeded' });
      http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({ id: 'j', status: 'succeeded' });
    });

    it('removing a field that was only staged cancels the add', () => {
      // Otherwise the batch asks the server to delete a field it has never
      // seen, and the engine fails the whole job on "no field called…".
      load();
      facade.stageAdd({ name: 'draft', type: 'text', page: 0 });
      facade.stageDelete('draft');
      expect(facade.pendingOps()).toEqual([]);
    });

    it('keeps one op per field however often it is dragged', () => {
      load();
      facade.stageUpdate({ name: 'full_name', type: 'text', page: 0,
                           rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.03 } });
      facade.stageUpdate({ name: 'full_name', type: 'text', page: 0,
                           rect: { x: 0.5, y: 0.5, w: 0.3, h: 0.03 } });
      expect(facade.pendingOps().length).toBe(1);
      expect(facade.pendingOps()[0].field.rect!.x).toBe(0.5);
    });

    it('a move on a staged add stays an add', () => {
      load();
      facade.stageAdd({ name: 'draft', type: 'text', page: 0,
                       rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.03 } });
      facade.stageUpdate({ name: 'draft', rect: { x: 0.4, y: 0.4, w: 0.3, h: 0.03 } });
      expect(facade.pendingOps()).toEqual([
        { action: 'add', field: { name: 'draft', type: 'text', page: 0,
                                  rect: { x: 0.4, y: 0.4, w: 0.3, h: 0.03 } } },
      ]);
    });

    it('knows which names are taken', () => {
      load();
      expect(facade.nameTaken('full_name')).toBe(true);
      expect(facade.nameTaken('nope')).toBe(false);
      facade.stageAdd({ name: 'nope', type: 'text', page: 0 });
      expect(facade.nameTaken('nope')).toBe(true);
    });

    it('commitFields is a no-op with nothing staged', () => {
      load();
      expect(facade.commitFields('doc-1', 1)).toBeNull();
    });
  });

  it('exports the current values as a file', () => {
    facade.exportData('doc-1', 'csv').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/form/export/'));
    expect(req.request.params.get('format')).toBe('csv');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['name,value\n']));
  });

  it('imports a data file through the job pipeline', () => {
    facade.importData('doc-1', 1, 'json', '{"full_name":"Ada"}').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/documents/doc-1/operations/'));
    expect(req.request.body.type).toBe('import_form_data');
    expect(req.request.body.params).toEqual({ format: 'json', data: '{"full_name":"Ada"}' });
    req.flush({ id: 'j', status: 'succeeded' });
    http.expectOne((r) => r.url.endsWith('/jobs/j/')).flush({ id: 'j', status: 'succeeded' });
  });
});
