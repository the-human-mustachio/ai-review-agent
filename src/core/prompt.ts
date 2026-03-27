import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'default.txt');

export function loadPrompt(customPath?: string): string {
  const promptPath = customPath || DEFAULT_PROMPT_PATH;
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt template not found: ${promptPath}`);
  }
  return fs.readFileSync(promptPath, 'utf-8');
}

export function renderPrompt(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value || '');
  }
  return result;
}
