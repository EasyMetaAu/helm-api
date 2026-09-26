import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMenuDismiss } from './menu';

function menu(id: string): HTMLDetailsElement {
  const el = document.createElement('details');
  el.className = 'menu';
  el.id = id;
  el.innerHTML = `<summary>⋯</summary><div class="menu-panel"><button class="menu-item">Go</button></div>`;
  el.open = true;
  document.body.append(el);
  return el;
}

const down = (target: Element) => target.dispatchEvent(new Event('pointerdown', { bubbles: true }));

describe('installMenuDismiss', () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installMenuDismiss(document);
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = '';
  });

  it('closes an open menu on a pointerdown outside it', () => {
    const a = menu('a');
    down(document.body);
    expect(a.open).toBe(false);
  });

  it('keeps the menu open for a pointerdown inside it', () => {
    const a = menu('a');
    down(a.querySelector('.menu-panel')!);
    expect(a.open).toBe(true);
  });

  it('opening one menu closes the other', () => {
    const a = menu('a');
    const b = menu('b');
    down(b.querySelector('summary')!);
    expect(a.open).toBe(false);
    expect(b.open).toBe(true);
  });

  it('closes the menu after an item is chosen', () => {
    const a = menu('a');
    (a.querySelector('.menu-item') as HTMLButtonElement).click();
    expect(a.open).toBe(false);
  });

  it('closes every menu on Escape', () => {
    const a = menu('a');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(a.open).toBe(false);
  });

  it('stops listening once uninstalled', () => {
    uninstall();
    const a = menu('a');
    down(document.body);
    expect(a.open).toBe(true);
    uninstall = installMenuDismiss(document);
  });
});
