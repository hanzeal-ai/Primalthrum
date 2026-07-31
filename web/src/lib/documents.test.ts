import { describe, expect, it } from 'vitest'

import { prepareTextDocument, validateDocumentBatch } from './documents'

describe('document preparation', () => {
  it('normalizes browser MIME metadata for supported text documents', async () => {
    const prepared = await prepareTextDocument(
      new File(['# Guide'], 'guide.md', { type: '' }),
    )

    expect(prepared).toEqual({
      name: 'guide.md',
      content: '# Guide',
      mimeType: 'text/markdown',
      sizeBytes: 7,
    })
  })

  it('rejects disguised and oversized attachment batches', async () => {
    await expect(prepareTextDocument(
      new File(['{}'], 'config.json', { type: 'image/png' }),
    )).rejects.toThrow('不匹配')

    expect(() => validateDocumentBatch([], Array.from({ length: 5 }, (_, index) => ({
      name: `${index}.txt`,
      content: 'x',
      mimeType: 'text/plain',
      sizeBytes: 1,
    })))).toThrow('最多添加 4 个文件')
  })
})
