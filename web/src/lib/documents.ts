export interface PreparedTextDocument {
  name: string
  content: string
  mimeType: string
  sizeBytes: number
}

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
export const MAX_DOCUMENTS_PER_ACTION = 4

export async function prepareTextDocument(file: File): Promise<PreparedTextDocument> {
  const mimeType = documentMimeType(file.name, file.type)
  const content = await file.text()
  const sizeBytes = new TextEncoder().encode(content).length
  if (!sizeBytes) throw new Error(`${file.name} 不能为空。`)
  if (sizeBytes > MAX_DOCUMENT_BYTES) throw new Error(`${file.name} 不能超过 2 MiB。`)
  return { name: file.name, content, mimeType, sizeBytes }
}

export function validateDocumentBatch(
  existing: PreparedTextDocument[],
  incoming: PreparedTextDocument[],
): void {
  if (existing.length + incoming.length > MAX_DOCUMENTS_PER_ACTION) {
    throw new Error(`一次最多添加 ${MAX_DOCUMENTS_PER_ACTION} 个文件。`)
  }
  const size = [...existing, ...incoming].reduce((total, file) => total + file.sizeBytes, 0)
  if (size > MAX_DOCUMENT_BYTES) throw new Error('文件总大小不能超过 2 MiB。')
}

function documentMimeType(filename: string, browserType: string): string {
  const extension = filename.toLowerCase().split('.').pop()
  const supported: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
  }
  const mimeType = supported[extension ?? '']
  if (!mimeType) throw new Error(`${filename} 的文件类型不受支持。`)
  if (browserType && ![mimeType, 'text/plain', 'text/json', 'application/csv'].includes(browserType)) {
    throw new Error(`${filename} 的文件类型与扩展名不匹配。`)
  }
  return mimeType
}
