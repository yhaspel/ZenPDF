import { strengthOf } from './protect';

/**
 * The strength meter is the one piece of judgement in the Protect panel, and a
 * meter that lies is worse than no meter: it teaches people to add punctuation
 * to a short word instead of making the word longer.
 */
describe('strengthOf', () => {
  it('says nothing about an empty box', () => {
    expect(strengthOf('')).toEqual({ score: 0, label: '' });
  });

  it('calls a short password short, however clever it is', () => {
    expect(strengthOf('aB3!').label).toBe('Too short');
    expect(strengthOf('Pw9$xQ2').label).toBe('Too short');
  });

  it('rates a long passphrase strong even with no punctuation', () => {
    expect(strengthOf('correct horse battery staple').score).toBe(3);
    expect(strengthOf('the quiet river bend').label).toBe('Strong');
  });

  it('does not call a short mixed-case password strong', () => {
    // 'P@ssw0rd!' has all four character classes and is famously terrible.
    expect(strengthOf('P@ssw0rd!').score).toBeLessThan(3);
  });

  it('rewards length over class variety at the margin', () => {
    expect(strengthOf('aaaaaaaaaaaaaaaa').score).toBe(3); // 16 chars
    expect(strengthOf('aA1!aA1!').score).toBe(1); // 8 chars, four classes
  });
});
