import { describe, expect, it } from 'vitest';
import { paginationItems } from './pagination.js';

describe('paginationItems', () => {
  it('returns a single page when there is one or fewer', () => {
    expect(paginationItems(1, 1)).toEqual([1]);
    expect(paginationItems(1, 0)).toEqual([1]);
  });

  it('lists every page with no ellipsis when they all fit', () => {
    expect(paginationItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('collapses the tail when near the start', () => {
    expect(paginationItems(1, 20)).toEqual([1, 2, 'ellipsis', 20]);
  });

  it('collapses both sides in the middle', () => {
    expect(paginationItems(10, 20)).toEqual([1, 'ellipsis', 9, 10, 11, 'ellipsis', 20]);
  });

  it('collapses the head when near the end', () => {
    expect(paginationItems(20, 20)).toEqual([1, 'ellipsis', 19, 20]);
  });

  it('clamps an out-of-range current page to the nearest in-bounds page', () => {
    expect(paginationItems(99, 20)).toEqual(paginationItems(20, 20));
    expect(paginationItems(0, 20)).toEqual(paginationItems(1, 20));
  });

  it('honours a wider window', () => {
    expect(paginationItems(10, 20, 2)).toEqual([1, 'ellipsis', 8, 9, 10, 11, 12, 'ellipsis', 20]);
  });
});
