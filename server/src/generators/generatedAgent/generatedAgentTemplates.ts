import { metadataTemplates } from './metadataTemplates';
import { runtimeTemplates } from './runtimeTemplates';
import type { GeneratedAgentTemplateInput, TemplateFile } from './templateTypes';
import { webTemplates } from './webTemplates';

export function generatedAgentTemplates(input: GeneratedAgentTemplateInput): TemplateFile[] {
  return [
    ...metadataTemplates(input),
    ...runtimeTemplates(),
    ...webTemplates(),
  ];
}
