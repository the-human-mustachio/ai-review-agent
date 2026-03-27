import fs from 'fs';

export function loadPrompt(customPath: string): string {
  if (!fs.existsSync(customPath)) {
    throw new Error(`Prompt template not found: ${customPath}`);
  }
  return fs.readFileSync(customPath, 'utf-8');
}

export function renderPrompt(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value || '');
  }
  return result;
}
