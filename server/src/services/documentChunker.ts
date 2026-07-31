export interface DocumentChunk {
  chunkId: string;
  text: string;
}

export interface DocumentChunkOptions {
  maxCharacters?: number;
  overlapCharacters?: number;
}

export function chunkDocumentText(
  documentId: number,
  content: string,
  options: DocumentChunkOptions = {},
): DocumentChunk[] {
  const maxCharacters = options.maxCharacters ?? 1_200;
  const overlapCharacters = options.overlapCharacters ?? 200;
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error('maxCharacters must be a positive integer');
  }
  if (
    !Number.isInteger(overlapCharacters)
    || overlapCharacters < 0
    || overlapCharacters >= maxCharacters
  ) {
    throw new Error('overlapCharacters must be non-negative and less than maxCharacters');
  }

  const characters = Array.from(content.replace(/\r\n?/g, '\n').trim());
  if (!characters.length) return [];

  const chunks: DocumentChunk[] = [];
  let start = 0;
  while (start < characters.length) {
    const end = Math.min(start + maxCharacters, characters.length);
    const text = characters.slice(start, end).join('').trim();
    if (text) {
      chunks.push({
        chunkId: `${documentId}:${chunks.length}`,
        text,
      });
    }
    if (end === characters.length) break;
    start = end - overlapCharacters;
  }
  return chunks;
}
