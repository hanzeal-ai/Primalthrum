import {
  DocumentScanUnavailableError,
  type DocumentMalwareScanner,
  DocumentThreatDetectedError,
} from './documentMalwareScanner';
import { type ParsedDocumentUpload } from './documentUpload';
import { DocumentUploadSecurityRepository } from './documentUploadSecurityRepository';

export class DocumentUploadSecurityService {
  constructor(
    private readonly scanner: DocumentMalwareScanner,
    private readonly events: DocumentUploadSecurityRepository,
  ) {}

  async inspect(input: {
    workspaceId: number;
    agentId: number;
    userId: number;
    upload: ParsedDocumentUpload;
  }): Promise<void> {
    try {
      const result = await this.scanner.scan(input.upload);
      this.events.record({ ...input, scanner: result.scanner, status: 'clean' });
    } catch (error) {
      if (error instanceof DocumentThreatDetectedError) {
        this.events.record({
          ...input,
          scanner: error.scanner,
          status: 'rejected',
          threatName: error.threatName,
        });
        throw error;
      }
      const unavailable = error instanceof DocumentScanUnavailableError
        ? error
        : new DocumentScanUnavailableError(this.scanner.name);
      this.events.record({
        ...input,
        scanner: unavailable.scanner,
        status: 'error',
        threatName: 'scanner-unavailable',
      });
      throw unavailable;
    }
  }
}
