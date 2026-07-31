export interface ParsedSseEvent {
  eventType: string;
  node: string;
  payload: Record<string, unknown>;
}

export async function pipeSseStream(
  response: Response,
  downstream: NodeJS.WritableStream,
  onEvent?: (event: ParsedSseEvent) => number | undefined,
): Promise<void> {
  if (!response.body) {
    throw new Error('Agent stream response has no body');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!onEvent) {
      downstream.write(Buffer.from(value));
    } else {
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (parsed) {
          downstream.write(formatSseEvent(parsed, onEvent(parsed)));
        }
      }
    }
  }

  if (onEvent) {
    buffer += decoder.decode();
    const parsed = parseSseBlock(buffer);
    if (parsed) {
      downstream.write(formatSseEvent(parsed, onEvent(parsed)));
    }
  }
}

export function formatSseEvent(event: ParsedSseEvent, id?: number): string {
  return [
    ...(id ? [`id: ${id}`] : []),
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(event.payload)}`,
    '',
    '',
  ].join('\n');
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split('\n').map((line) => line.trimEnd());
  const eventType = lines
    .find((line) => line.startsWith('event:'))
    ?.replace('event:', '')
    .trim() || 'message';
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace('data:', '').trim())
    .join('');

  if (!data) {
    return null;
  }

  const payload = JSON.parse(data) as Record<string, unknown>;
  return {
    eventType,
    node: typeof payload.node === 'string' ? payload.node : '',
    payload,
  };
}
