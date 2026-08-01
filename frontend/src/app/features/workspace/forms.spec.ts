import { FormField } from '../../core/models/models';
import { radioLayout, specOf } from './forms';

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
