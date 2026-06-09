import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import StreamViewer from './StreamViewer.svelte';

// StreamViewer renders a captured SSE stream three ways: Assembled (default —
// the final message a client would have seen), Chunks (one row per event with a
// kind badge, full JSON on expand), and Raw (verbatim wire text). It exists
// because JsonViewer's fail-soft path dumped streams as an unreadable wall of
// `data:` lines. i18n falls back to the English key in tests.

function openaiChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1780000000,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    usage: finish ? { prompt_tokens: 6, completion_tokens: 54, total_tokens: 60 } : null,
  })}\n\n`;
}

const STREAM = [
  openaiChunk({ role: 'assistant', content: null, reasoning_content: '' }),
  openaiChunk({ reasoning_content: 'We should greet.' }),
  openaiChunk({ content: 'Hi' }),
  openaiChunk({ content: '!' }),
  openaiChunk({ content: '' }, 'stop'),
  'data: [DONE]\n\n',
].join('');

const RESPONSES_STREAM = [
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    sequence_number: 0,
    delta: '我',
  })}\n\n`,
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    sequence_number: 1,
    delta: '在',
  })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    sequence_number: 2,
    response: { model: 'gpt-5.5', status: 'completed' },
  })}\n\n`,
].join('');

describe('StreamViewer', () => {
  it('defaults to the Assembled tab with the final content prominent', () => {
    render(StreamViewer, { raw: STREAM });
    const assembled = screen.getByTestId('streamviewer-assembled');
    expect(assembled).toBeVisible();
    expect(screen.getByTestId('stream-final-content')).toHaveTextContent('Hi!');
  });

  it('shows reasoning in a collapsed details block', () => {
    render(StreamViewer, { raw: STREAM });
    const reasoning = screen.getByTestId('stream-reasoning');
    expect(reasoning).not.toHaveAttribute('open');
    expect(reasoning).toHaveTextContent('We should greet.');
  });

  it('summarizes finish reason, model and chunk count', () => {
    render(StreamViewer, { raw: STREAM });
    const assembled = screen.getByTestId('streamviewer-assembled');
    expect(assembled).toHaveTextContent('stop');
    expect(assembled).toHaveTextContent('deepseek-v4-flash');
    expect(assembled).toHaveTextContent('6'); // 6 events incl. [DONE]
  });

  it('switches to the Chunks tab listing one row per event with kind badges', async () => {
    render(StreamViewer, { raw: STREAM });
    await fireEvent.click(screen.getByRole('button', { name: /Chunks/i }));
    const chunks = screen.getByTestId('streamviewer-chunks');
    expect(chunks).toBeVisible();
    expect(screen.getAllByTestId('stream-chunk-row')).toHaveLength(6);
    // delta text is visible directly in the row
    expect(chunks).toHaveTextContent('We should greet.');
    expect(chunks).toHaveTextContent('[DONE]');
  });

  it('switches to the Raw tab showing verbatim wire text', async () => {
    render(StreamViewer, { raw: STREAM });
    await fireEvent.click(screen.getByRole('button', { name: /Raw/i }));
    const raw = screen.getByTestId('streamviewer-raw');
    expect(raw).toBeVisible();
    expect(raw.textContent).toContain('data: {"id":"cmpl-1"');
  });

  it('renders tool calls with their assembled arguments', () => {
    const toolStream = [
      openaiChunk({
        tool_calls: [
          {
            index: 0,
            id: 'c1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":' },
          },
        ],
      }),
      openaiChunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      openaiChunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ].join('');
    render(StreamViewer, { raw: toolStream });
    const tools = screen.getByTestId('stream-tool-calls');
    expect(tools).toHaveTextContent('get_weather');
    expect(tools).toHaveTextContent('"city": "Paris"');
  });

  it('shows a placeholder when the stream produced no visible content', () => {
    render(StreamViewer, { raw: 'data: [DONE]\n\n' });
    expect(screen.getByTestId('streamviewer-assembled')).toHaveTextContent('No visible output');
  });

  it('passes a testid through to its root for e2e selectors', () => {
    render(StreamViewer, { raw: STREAM, testid: 'response-body' });
    expect(screen.getByTestId('response-body')).toBeInTheDocument();
  });

  it('renders OpenAI Responses API output_text.delta streams as assembled content', () => {
    render(StreamViewer, { raw: RESPONSES_STREAM });
    expect(screen.getByTestId('stream-final-content')).toHaveTextContent('我在');
    expect(screen.queryByText(/No visible output/)).not.toBeInTheDocument();
  });
});
