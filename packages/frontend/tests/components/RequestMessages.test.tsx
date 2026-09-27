import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import RequestMessages from '../../src/components/RequestMessages';

const recording = {
  request_body: {
    messages: [{ role: 'user', content: 'What is the weather?' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'Read the forecast',
          parameters: { type: 'object' },
        },
      },
    ],
  },
  response_body: {
    type: 'json' as const,
    body: { choices: [{ message: { role: 'assistant', content: 'Sunny.' } }] },
  },
  wire_format: 'openai_chat_completions',
};

describe('RequestMessages', () => {
  afterEach(cleanup);

  it('renders the recorded conversation and response', () => {
    const { getAllByText } = render(() => <RequestMessages recording={recording} />);
    expect(getAllByText('What is the weather?')).toHaveLength(2);
    expect(getAllByText('Sunny.')).toHaveLength(2);
  });

  it('shows called and available tools in the tools tab', () => {
    const calledRecording = {
      ...recording,
      response_body: {
        type: 'json' as const,
        body: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'weather', arguments: '{"city":"Paris"}' },
                  },
                ],
              },
            },
          ],
        },
      },
    };
    const { getAllByText, getByText } = render(() => (
      <RequestMessages recording={calledRecording} view="tools" />
    ));
    // 'weather' appears once in Called and once in Available
    expect(getAllByText('weather')).toHaveLength(2);
    expect(getByText('call-1')).toBeTruthy();
    // JSON arguments are syntax-highlighted (hljs splits across spans), check body text
    expect(document.body.textContent).toContain('"city"');
    expect(document.body.textContent).toContain('"Paris"');
    // Available section shows the tool description
    expect(getByText('Read the forecast')).toBeTruthy();
  });

  it('shows raw payloads when view is raw', () => {
    const { getByText } = render(() => <RequestMessages recording={recording} view="raw" />);
    expect(getByText('Request')).toBeTruthy();
    expect(getByText('Response')).toBeTruthy();
  });

  it('renders message metadata and tool-call details safely', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const detailedRecording = {
      ...recording,
      request_body: {
        messages: [
          { role: 'developer', name: 'planner' },
          {},
          {
            role: 'assistant',
            tool_calls: [{ id: 'call-1', function: { arguments: circular } }],
          },
          { role: 'tool', tool_call_id: 'call-1', content: 'Tool complete' },
        ],
        tools: [{ type: 'custom' }, {}],
      },
      response_body: null,
    };

    const { getByText, getAllByText } = render(() => (
      <RequestMessages recording={detailedRecording} />
    ));

    expect(getByText('developer')).toBeTruthy();
    expect(getAllByText('unknown')).toHaveLength(2);
    expect(getByText('planner')).toBeTruthy();

    // Turns are open by default — tool call content is already visible.
    expect(getByText('Unknown tool')).toBeTruthy();
    expect(getAllByText('call-1')).toHaveLength(2);
    // Circular reference serialises to '[object Object]' which hljs may split across spans;
    // verify the text is present anywhere in the rendered output.
    expect(document.body.textContent).toContain('[object Object]');
    expect(getAllByText('Tool complete')).toHaveLength(2);
  });

  it('explains empty conversations and tool lists', () => {
    const emptyRecording = {
      ...recording,
      request_body: {},
      response_body: null,
    };

    const { getByText } = render(() => <RequestMessages recording={emptyRecording} />);
    expect(getByText('No conversation turns found.')).toBeTruthy();
    cleanup();

    const { getByText: getText2 } = render(() => (
      <RequestMessages recording={emptyRecording} view="tools" />
    ));
    expect(getText2('No tools were called in this conversation.')).toBeTruthy();
  });

  it('explains when logs were off for the attempt', () => {
    const { getByText } = render(() => <RequestMessages recording={null} />);
    expect(getByText('No logs for this attempt')).toBeTruthy();
    expect(
      getByText('Logs were off when this attempt ran. Enable logs in Settings to inspect future requests.'),
    ).toBeTruthy();
  });

  it('shows and hides tooltip on TruncatedId hover', () => {
    const calledRecording = {
      ...recording,
      response_body: {
        type: 'json' as const,
        body: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-tooltip-test',
                    type: 'function',
                    function: { name: 'weather', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        },
      },
    };
    render(() => <RequestMessages recording={calledRecording} view="tools" />);
    const idEl = document.querySelector('.request-messages__tool-id')!;
    expect(idEl).toBeTruthy();
    fireEvent.mouseEnter(idEl);
    expect(document.querySelector('[role="tooltip"]')).toBeTruthy();
    fireEvent.mouseLeave(idEl);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
