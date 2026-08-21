import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FormsFacade } from '../../abstraction/forms.facade';
import { EditorClipboard } from '../../shared/editor-clipboard.service';
import { OverlayMenuAction } from '../../shared/page-overlay/overlay-model';
import { FormField } from '../../core/models/models';
import { Forms, radioLayout, specOf } from './forms';

const FIELD: FormField = {
  name: 'who',
  type: 'text',
  page: 0,
  rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.03 },
  value: 'typed',
  default: 'seed',
  align: 'center',
  font_size: 18,
  options: [],
  flags: { required: true, readonly: false, multiline: true, password: false },
  max_len: 12,
  widgets: [{ page: 0, rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, on_value: '' }],
};

describe('radioLayout', () => {
  const rect = { x: 0.1, y: 0.9, w: 0.4, h: 0.03 };

  it('never gives two options the same box', () => {
    // Clamping each row to the page instead of laying the group out as a whole
    // gave every option past the bottom an identical rect — invisible,
    // unclickable, and accepted by the engine because each one was valid.
    const rects = radioLayout(rect, 5);
    const ys = rects.map((r) => r.y);
    expect(new Set(ys).size).toBe(5);
    for (const r of rects) {
      expect(r.y + r.h).toBeLessThanOrEqual(1.0001);
    }
  });

  it('keeps the drawn position when the group fits', () => {
    const rects = radioLayout({ x: 0.1, y: 0.2, w: 0.4, h: 0.03 }, 3);
    expect(rects[0].y).toBeCloseTo(0.2, 5);
    expect(rects[1].y).toBeCloseTo(0.242, 5);
    expect(rects[2].y).toBeCloseTo(0.284, 5);
  });

  it('compresses rather than overlaps when there are too many options', () => {
    const rects = radioLayout({ x: 0.1, y: 0.5, w: 0.4, h: 0.05 }, 40);
    expect(new Set(rects.map((r) => r.y)).size).toBe(40);
    expect(rects[39].y + 0.05).toBeLessThanOrEqual(1.0001);
  });
});

describe('specOf', () => {
  it('carries every property an update would otherwise reset', () => {
    // An update is delete-then-add, so anything the spec omits is gone:
    // dragging a field used to wipe its max length, alignment and font size.
    expect(specOf(FIELD)).toEqual({
      name: 'who',
      type: 'text',
      page: 0,
      rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.03 },
      rects: undefined,
      options: undefined,
      required: true,
      readonly: false,
      multiline: true,
      align: 'center',
      max_len: 12,
      font_size: 18,
      default: 'seed',
    });
  });

  it('carries every placement of a radio group', () => {
    const group: FormField = {
      ...FIELD,
      name: 'plan',
      type: 'radio',
      options: ['basic', 'pro'],
      widgets: [
        { page: 0, rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, on_value: 'basic' },
        { page: 0, rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.03 }, on_value: 'pro' },
      ],
    };
    expect(specOf(group).rects?.length).toBe(2);
    expect(specOf(group).options).toEqual(['basic', 'pro']);
  });
});

/**
 * The form builder's clipboard and history (phase-12 §4.3).
 *
 * A field's *name* is its identity in the AcroForm — two fields sharing one are
 * two views of the same value, which is emphatically not what "duplicate"
 * means — so the interesting assertion here is that a copy gets a name of its
 * own.
 */
describe('Forms — duplicate, paste and undo', () => {
  let fixture: ComponentFixture<Forms>;
  let forms: FormsFacade;
  let clipboard: EditorClipboard;

  const api = () => fixture.componentInstance as unknown as {
    copyField(name?: string | null): boolean;
    duplicateField(name?: string | null): boolean;
    pasteField(): boolean;
    onContextTarget(id: string | null): void;
    menuActionsFor(id: string | null): OverlayMenuAction[];
    canPaste(): boolean;
    tab: { set(v: 'fill' | 'build'): void };
    page: { set(v: number): void };
    selectedName(): string | null;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Forms],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    forms = TestBed.inject(FormsFacade);
    forms.reset();
    clipboard = TestBed.inject(EditorClipboard);
    clipboard.clear();

    fixture = TestBed.createComponent(Forms);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.detectChanges();
    api().tab.set('build');
  });

  afterEach(() => TestBed.resetTestingModule());

  function stageOne(): void {
    forms.stageAdd({
      name: 'who', type: 'text', page: 0, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.04 },
    });
  }

  it('gives a duplicate a name of its own', () => {
    stageOne();
    expect(api().duplicateField('who')).toBe(true);

    const names = forms.pendingOps().map((op) => op.field.name);
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(2);
  });

  it('offsets the duplicate so it is visibly a second field', () => {
    stageOne();
    api().duplicateField('who');
    const copy = forms.pendingOps()[1].field;
    expect(copy.rect!.x).toBeCloseTo(0.12);
    expect(copy.rect!.y).toBeCloseTo(0.12);
  });

  it('re-lays a radio group out rather than pasting overlapping rows', () => {
    forms.stageAdd({
      name: 'pick', type: 'radio', page: 0,
      options: ['a', 'b', 'c'],
      rects: radioLayout({ x: 0.1, y: 0.1, w: 0.3, h: 0.03 }, 3),
    });
    api().duplicateField('pick');
    const copy = forms.pendingOps()[1].field;
    expect(copy.rects!.length).toBe(3);
    const ys = copy.rects!.map((r) => r.y);
    expect(new Set(ys.map((y) => y.toFixed(4))).size).toBe(3);
  });

  it('pastes onto the page being looked at', () => {
    stageOne();
    api().copyField('who');
    api().page.set(2);
    expect(api().pasteField()).toBe(true);
    expect(forms.pendingOps()[1].field.page).toBe(2);
  });

  it('undoes a staged field change in one step', () => {
    stageOne();
    expect(forms.pendingOps().length).toBe(1);
    forms.undo();
    expect(forms.pendingOps().length).toBe(0);
    forms.redo();
    expect(forms.pendingOps().length).toBe(1);
  });

  it('offers the field actions on a field, and Paste on empty page', () => {
    stageOne();
    api().onContextTarget('who#0');
    expect(api().menuActionsFor('who#0').map((a) => a.id))
      .toEqual(['copy', 'duplicate', 'properties', 'delete']);

    api().onContextTarget(null);
    expect(api().menuActionsFor(null)).toEqual([]);

    api().copyField('who');
    api().onContextTarget(null);
    expect(api().menuActionsFor(null).map((a) => a.id)).toEqual(['paste']);
  });

  it('does nothing for a field that is not there', () => {
    expect(api().copyField('ghost')).toBe(false);
    expect(api().duplicateField('ghost')).toBe(false);
  });
});
