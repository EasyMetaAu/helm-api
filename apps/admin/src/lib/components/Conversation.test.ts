import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Conversation from './Conversation.svelte';

// Conversation renders a captured request+response as a scannable, collapsed-by-
// default timeline. Each row is a one-line summary that expands on click; raw JSON
// is a hover-revealed { } affordance per turn; system prompts are hidden behind one
// chip; a toolbar carries role filter + expand/collapse-all + jump-to-first-reply.
// Wire→turns folding (incl. empty suppression + tool pairing) is covered in
// conversation.test.ts — here we pin the RENDER contract via stable testids.
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
  it('renders under the passed testid; system prompt hidden by default (chip, not a row)', () => {
    render(Conversation, { request: MULTITURN, response: null, testid: 'conversation' });
    expect(screen.getByTestId('conversation')).toBeInTheDocument();
    // 3 message rows; the system prompt is behind a chip, not rendered as a row
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(3);
    expect(screen.getByTestId('conversation').textContent).not.toContain('Be precise.');
    expect(screen.getByTestId('conversation-show-system')).toBeInTheDocument();
  });

  it('tags each row with its role via data-turn-role in order', () => {
    render(Conversation, { request: MULTITURN, response: null });
    const rows = screen.getAllByTestId('conversation-turn');
    expect(rows.map((r) => r.getAttribute('data-turn-role'))).toEqual(['user', 'assistant', 'user']);
    // role-colored left spine (design-token class)
    expect(rows[0].className).toContain('border-slate-200'); // user
    expect(rows[1].className).toContain('border-indigo-200'); // assistant
  });

  it('rows are collapsed by default and expand on click', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    const rows = screen.getAllByTestId('conversation-turn');
    expect(rows[0].getAttribute('data-open')).toBe('false');
    await fireEvent.click(within(rows[0]).getByTestId('conversation-row-toggle'));
    expect(rows[0].getAttribute('data-open')).toBe('true');
  });

  it('clicking the system chip reveals the system prompt as a row', async () => {
    render(Conversation, { request: MULTITURN, response: null, testid: 'conversation' });
    await fireEvent.click(screen.getByTestId('conversation-show-system'));
    const rows = screen.getAllByTestId('conversation-turn');
    expect(rows).toHaveLength(4);
    expect(rows[0].getAttribute('data-turn-role')).toBe('system');
  });

  it('"View source" reveals only the clicked turn (no wrong-index bleed)', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    const rows = screen.getAllByTestId('conversation-turn');
    expect(screen.queryAllByTestId('conversation-source')).toHaveLength(0);
    await fireEvent.click(within(rows[0]).getByTestId('conversation-source-toggle'));
    expect(screen.getAllByTestId('conversation-source')).toHaveLength(1);
    expect(within(rows[0]).queryByTestId('conversation-source')).not.toBeNull();
    expect(within(rows[1]).queryByTestId('conversation-source')).toBeNull();
    expect(rows[0].textContent).toContain('hello'); // that turn's raw wire object
  });

  it('reasoning is collapsed by default, expands via "Show reasoning" (once the row is open)', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    // expand the assistant row so its body (incl. reasoning) mounts
    const rows = screen.getAllByTestId('conversation-turn');
    await fireEvent.click(within(rows[1]).getByTestId('conversation-row-toggle'));
    const reasoning = screen.getByTestId('conversation-reasoning');
    expect(reasoning).toHaveTextContent('ponder');
    expect(reasoning).not.toHaveAttribute('open');
    await fireEvent.click(screen.getByTestId('conversation-toggle-reasoning'));
    expect(screen.getByTestId('conversation-reasoning')).toHaveAttribute('open');
  });

  it('"Expand all" opens every row at once', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    await fireEvent.click(screen.getByTestId('conversation-expand-all'));
    for (const r of screen.getAllByTestId('conversation-turn')) expect(r.getAttribute('data-open')).toBe('true');
  });

  it('a REPEATED "Expand all" re-opens a row collapsed in between (nonce re-fires)', async () => {
    render(Conversation, { request: MULTITURN, response: null });
    await fireEvent.click(screen.getByTestId('conversation-expand-all'));
    const row0 = screen.getAllByTestId('conversation-turn')[0];
    // manually collapse row 0
    await fireEvent.click(within(row0).getByTestId('conversation-row-toggle'));
    expect(row0.getAttribute('data-open')).toBe('false');
    // second Expand all must re-open it (the Codex-found bug)
    await fireEvent.click(screen.getByTestId('conversation-expand-all'));
    expect(screen.getAllByTestId('conversation-turn')[0].getAttribute('data-open')).toBe('true');
  });

  it('role filter narrows to a single role', async () => {
    render(Conversation, { request: MULTITURN, response: null, testid: 'conversation' });
    const filter = screen.getByTestId('conversation-filter');
    await fireEvent.click(within(filter).getByText('Assistant'));
    const rows = screen.getAllByTestId('conversation-turn');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-turn-role')).toBe('assistant');
  });

  it('a tool call and its result render as ONE merged tool block, open by default (no extra click)', () => {
    render(Conversation, {
      request: {
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'get_weather', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
        ],
      },
      response: null,
    });
    // one row (the tool result turn was folded away)
    const rows = screen.getAllByTestId('conversation-turn');
    expect(rows).toHaveLength(1);
    // tool-only turn is expanded by default — the block is there without any click
    expect(rows[0].getAttribute('data-open')).toBe('true');
    const tool = screen.getByTestId('conversation-tool');
    expect(tool).toHaveTextContent('get_weather');
    expect(tool).toHaveTextContent('ok'); // result status glyph label
  });

  it('tool-only turn shows Name(args) + output peek inline WITHOUT a click; full viewer on click', async () => {
    // The whole friction fix: a turn that is just a tool call opens by default, so the
    // header + inline peek are visible immediately. Only the full JsonViewer is gated.
    render(Conversation, {
      request: {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls -la' } }] },
          { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8' }] },
        ],
      },
      response: null,
    });
    const row = screen.getByTestId('conversation-turn');
    // NO click — the tool block, header, and peek are present on first render
    expect(row.getAttribute('data-open')).toBe('true');
    const tool = screen.getByTestId('conversation-tool');
    expect(tool).toHaveTextContent('Bash(ls -la)');
    // inline peek shows the first lines; 8 lines total, 6 shown → "+2 lines"
    expect(tool).toHaveTextContent('line1');
    expect(tool).toHaveTextContent('+2');
    // full JsonViewer NOT mounted until we ask for it
    expect(within(tool).queryByText('Arguments')).toBeNull();
    // ONE click on the expand affordance → full args + result appear
    await fireEvent.click(within(tool).getByTestId('conversation-tool-expand'));
    expect(within(tool).getByText('Arguments')).toBeInTheDocument();
    expect(within(tool).getByText('Result')).toBeInTheDocument();
  });

  it('tool-only turn shows the key argument in the parens, not a blind Name()', () => {
    // Real Anthropic tool_use shape (the box capture): the header must read `Bash(grep …)`
    // so the reader sees WHAT the tool did, not just that it ran.
    render(Conversation, {
      request: {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -rn foo scripts/', description: 'search' } }],
          },
        ],
      },
      response: null,
    });
    const row = screen.getByTestId('conversation-turn');
    // tool-only → open by default; the header carries the arg detail with no click
    expect(row.getAttribute('data-open')).toBe('true');
    expect(row.textContent).toContain('Bash(grep -rn foo scripts/)');
    expect(row.textContent).not.toContain('Bash()');
  });

  it('a MIXED turn (text + tool) still starts collapsed', () => {
    // Only pure tool turns auto-expand; a turn with prose stays one-line to keep long
    // traces scannable. Here the assistant narrates AND calls a tool in one turn.
    render(Conversation, {
      request: {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check the weather.' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'weather' } },
            ],
          },
        ],
      },
      response: null,
    });
    const row = screen.getByTestId('conversation-turn');
    expect(row.getAttribute('data-open')).toBe('false');
  });

  it('image renders ImagePreview (not base64) once expanded', async () => {
    const b64 = `iVBORw0KGgo${'A'.repeat(40)}`;
    render(Conversation, {
      request: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }] },
      response: null,
    });
    const row = screen.getByTestId('conversation-turn');
    await fireEvent.click(within(row).getByTestId('conversation-row-toggle'));
    expect(row.textContent).not.toContain(b64);
    expect(row.querySelector('img')).not.toBeNull();
  });

  it('empty content never renders a row (normalizer suppression)', () => {
    render(Conversation, {
      request: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '   ' }] },
      response: null,
    });
    // the whitespace-only assistant turn is gone
    const rows = screen.getAllByTestId('conversation-turn');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-turn-role')).toBe('user');
  });

  it('long transcript renders every row (collapsed rows are cheap)', () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    render(Conversation, { request: { messages }, response: null });
    expect(screen.getAllByTestId('conversation-turn').length).toBe(60);
  });

  it('empty / unrecognized body → empty-state, never crashes', () => {
    render(Conversation, { request: { foo: 'bar' }, response: null, testid: 'conversation' });
    expect(screen.getByTestId('conversation-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('conversation-turn')).toHaveLength(0);
  });
});
