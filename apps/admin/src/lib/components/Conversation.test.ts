import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Conversation from './Conversation.svelte';

// Conversation renders a captured request+response as a back-and-forth chat: user/
// tool bubbles align right, assistant/system left. Heavy content (system prompt,
// reasoning) starts collapsed; each turn has a "View source" toggle that reveals
// ONLY that turn's raw JSON. The wire→turns folding is covered exhaustively in
// conversation.test.ts — here we pin the RENDER contract (sides, toggles, images,
// the wrong-index source bug, the empty path) via stable testids, not markup.
// i18n falls back to the English key in tests.

const MULTITURN = {
  system: 'Be precise.',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'ponder' }, { type: 'text', text: 'hi back' }] },
    { role: 'user', content: 'thanks' },
  ],
};

describe('Conversation', () => {
  it('renders under the passed testid and one bubble per turn', () => {
    render(Conversation, { request: MULTITURN, response: null, testid: 'conversation' });
    expect(screen.getByTestId('conversation')).toBeInTheDocument();
    // system + 3 messages = 4 turns
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(4);
  });

  it('aligns user/tool right and assistant/system left via data-turn-role', () => {
    render(Conversation, { request: MULTITURN, response: null });
    const rows = screen.getAllByTestId('conversation-turn');
    const roles = rows.map((r) => r.getAttribute('data-turn-role'));
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    // right-aligned turns carry items-end; left-aligned items-start
    const user = rows[1];
    expect(user.className).toContain('items-end');
    const assistant = rows[2];
    expect(assistant.className).toContain('items-start');
  });

  it('"View source" reveals only the clicked turn (no wrong-index bleak)', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    const rows = screen.getAllByTestId('conversation-turn');
    // nothing open initially
    expect(screen.queryAllByTestId('conversation-source')).toHaveLength(0);
    // open turn #2 (index 1, the first user message)
    const toggle = within(rows[1]).getByTestId('conversation-source-toggle');
    await fireEvent.click(toggle);
    // exactly one source panel, and it's inside row #2
    const sources = screen.getAllByTestId('conversation-source');
    expect(sources).toHaveLength(1);
    expect(within(rows[1]).queryByTestId('conversation-source')).not.toBeNull();
    expect(within(rows[2]).queryByTestId('conversation-source')).toBeNull();
    // the revealed JSON is that turn's raw wire object
    expect(rows[1].textContent).toContain('hello');
  });

  it('system turn is hidden until "Show system" is toggled', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    const systemRow = screen.getAllByTestId('conversation-turn')[0];
    expect(systemRow.textContent).not.toContain('Be precise.');
    await fireEvent.click(screen.getByTestId('conversation-toggle-system'));
    expect(screen.getAllByTestId('conversation-turn')[0].textContent).toContain('Be precise.');
  });

  it('reasoning block is present in DOM but collapsed by default', () => {
    render(Conversation, { request: MULTITURN, response: null });
    const reasoning = screen.getByTestId('conversation-reasoning');
    expect(reasoning).toHaveTextContent('ponder'); // content in the tree
    expect(reasoning).not.toHaveAttribute('open'); // but folded
  });

  it('expands reasoning when "Show reasoning" is toggled', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    await fireEvent.click(screen.getByTestId('conversation-toggle-reasoning'));
    expect(screen.getByTestId('conversation-reasoning')).toHaveAttribute('open');
  });

  it('image turn renders ImagePreview, never a base64 wall', () => {
    const b64 = `iVBORw0KGgo${'A'.repeat(40)}`;
    render(Conversation, {
      request: {
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }],
      },
      response: null,
    });
    // ImagePreview thumb exposes its own trigger; the base64 string is not text
    const row = screen.getByTestId('conversation-turn');
    expect(row.textContent).not.toContain(b64);
    expect(row.querySelector('img')).not.toBeNull();
  });

  it('long transcript renders all rows without error when expanded', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    render(Conversation, { request: { messages }, response: null });
    // capped at 50 initially, "show all" reveals the rest
    expect(screen.getAllByTestId('conversation-turn').length).toBe(50);
    await fireEvent.click(screen.getByTestId('conversation-show-all'));
    expect(screen.getAllByTestId('conversation-turn').length).toBe(60);
  });

  it('empty / unrecognized body → empty-state, never crashes', () => {
    render(Conversation, { request: { foo: 'bar' }, response: null, testid: 'conversation' });
    expect(screen.getByTestId('conversation-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('conversation-turn')).toHaveLength(0);
  });
});
