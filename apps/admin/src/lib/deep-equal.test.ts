import { describe, expect, it } from 'vitest';
import { deepEqual } from './deep-equal.js';

describe('deepEqual', () => {
  it('treats identical primitives / null as equal', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
  });

  it('distinguishes differing primitives and null vs object', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it('compares nested objects structurally, ignoring key order', () => {
    const inbound = { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false };
    const same = { stream: false, messages: [{ content: 'hi', role: 'user' }], model: 'auto' };
    expect(deepEqual(inbound, same)).toBe(true);
  });

  it('detects an injected memory turn (the real "differs" case)', () => {
    const inbound = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
    const forwarded = {
      model: 'claude-x',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: '<system-reminder># Persistent memory</system-reminder>' },
      ],
    };
    expect(deepEqual(inbound, forwarded)).toBe(false);
  });

  it('is array order-sensitive and length-sensitive', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('distinguishes an array from an object', () => {
    expect(deepEqual([], {})).toBe(false);
  });

  it('detects extra / missing keys', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('compares raw strings (non-JSON streamed bodies) directly', () => {
    expect(deepEqual('data: [DONE]', 'data: [DONE]')).toBe(true);
    expect(deepEqual('a', 'b')).toBe(false);
  });
});
