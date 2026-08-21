export interface GeneratedAgentTemplateInput {
  name: string;
  slug: string;
  description: string;
  runtime: unknown;
}

export interface TemplateFile {
  path: string;
  content: string;
}
