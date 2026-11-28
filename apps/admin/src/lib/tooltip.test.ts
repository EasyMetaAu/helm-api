import { afterEach, describe, expect, it } from 'vitest';
import { tooltip } from './tooltip';

function mount(text: string, rect: Partial<DOMRect>) {
  const node = document.createElement('button');
  document.body.append(node);
  node.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 28, height: 28, bottom: 28, right: 28, ...rect }) as DOMRect;
  const action = tooltip(node, text);
  return { node, action };
}

const tip = () => document.body.querySelector<HTMLElement>('[role="tooltip"]');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tooltip action', () => {
  it('shows immediately on hover and hides on leave', () => {
    const { node } = mount('Fast mode · On', { top: 300, bottom: 328, left: 400, right: 428 });
    expect(tip()).toBeNull();
    node.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tip()).toHaveTextContent('Fast mode · On');
    expect(node.getAttribute('aria-describedby')).toBe(tip()?.id);
    node.dispatchEvent(new MouseEvent('mouseleave'));
    expect(tip()).toBeNull();
    expect(node.hasAttribute('aria-describedby')).toBe(false);
  });

  it('also shows on keyboard focus', () => {
    const { node } = mount('Proxy', { top: 300, bottom: 328 });
    node.dispatchEvent(new FocusEvent('focus'));
    expect(tip()).toHaveTextContent('Proxy');
    node.dispatchEvent(new FocusEvent('blur'));
    expect(tip()).toBeNull();
  });

  it('lives in the top-level layer, not inside the trigger container', () => {
    const { node } = mount('x', { top: 300, bottom: 328 });
    node.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tip()?.parentElement).toBe(document.body);
  });

  it('flips below the trigger when there is no room above', () => {
    const { node } = mount('x', { top: 2, bottom: 30 });
    node.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tip()?.dataset.side).toBe('bottom');
  });

  it('updates text and cleans up on destroy', () => {
    const { node, action } = mount('old', { top: 300, bottom: 328 });
    action.update('new');
    node.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tip()).toHaveTextContent('new');
    action.destroy();
    expect(tip()).toBeNull();
  });
});
