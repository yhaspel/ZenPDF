import { apiError } from '../../core/api-error';
import { firstFieldError } from './register';

/**
 * What the register form says when the server refuses.
 *
 * The rule the component applies is `firstFieldError(details) ?? message ??
 * 'Registration failed.'`, and the order is the point: DRF reports a
 * `validation_error` per field, and "That address is already registered" is
 * both the most common refusal this form gets and the only one that tells
 * somebody what to do next. The generic sentence is the last resort, not the
 * first.
 *
 * Nothing covered this before — it was three lines walking an `any` inside an
 * error callback — and it is the path a real person hits by typing an email
 * they have already used.
 */
describe('firstFieldError', () => {
  /** The shape `apps/core/exceptions.py` sends for a serializer failure. */
  function validationError(fields: Record<string, unknown>) {
    return apiError({
      status: 400,
      error: { error: { code: 'validation_error', message: 'Invalid input.', details: { fields } } },
    }).details;
  }

  it('takes the first message of the first field', () => {
    expect(firstFieldError(validationError({
      email: ['That address is already registered.'],
      password: ['This password is too common.'],
    }))).toBe('That address is already registered.');
  });

  it('accepts a bare string as well as a list', () => {
    // DRF sends a list; a plain string is cheap to survive and was already
    // handled by the `Array.isArray` the old spelling had.
    expect(firstFieldError(validationError({ email: 'Enter a valid email address.' })))
      .toBe('Enter a valid email address.');
  });

  it('falls through when there is no field error to show', () => {
    // Each of these must return undefined so the caller's `?? message ??
    // 'Registration failed.'` can do its job. An empty list is the one that
    // matters: `fields.email = []` is a field that failed with nothing to say.
    expect(firstFieldError(undefined)).toBeUndefined();
    expect(firstFieldError({})).toBeUndefined();
    expect(firstFieldError(validationError({}))).toBeUndefined();
    expect(firstFieldError(validationError({ email: [] }))).toBeUndefined();
    expect(firstFieldError({ fields: 'not an object' })).toBeUndefined();
    expect(firstFieldError({ fields: null })).toBeUndefined();
  });

  it('ignores a field message that is not a string', () => {
    expect(firstFieldError(validationError({ email: [42] }))).toBeUndefined();
    expect(firstFieldError(validationError({ email: { nested: true } }))).toBeUndefined();
  });

  it('is undefined for the errors that carry no field detail at all', () => {
    // A 429, a 403 — the envelope's own `message` is the whole answer there.
    expect(firstFieldError(apiError({
      status: 429,
      error: { error: { code: 'throttled', message: 'Too many attempts.' } },
    }).details)).toBeUndefined();
  });
});
