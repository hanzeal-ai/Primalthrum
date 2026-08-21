import { WEB_DOCUMENT } from './webDocumentTemplate';
import { WEB_SCRIPT } from './webScriptTemplate';
import { WEB_STYLES } from './webStyleTemplate';
import type { TemplateFile } from './templateTypes';

export function webTemplates(): TemplateFile[] {
  return [
    { path: 'src/web/index.html', content: WEB_DOCUMENT },
    { path: 'src/web/app.js', content: WEB_SCRIPT },
    { path: 'src/web/styles.css', content: WEB_STYLES },
  ];
}
