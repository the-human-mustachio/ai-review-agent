const fs = require('fs');
const path = require('path');

const DEFAULT_PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'default.txt');

function loadPrompt(customPath) {
  const promptPath = customPath || DEFAULT_PROMPT_PATH;
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt template not found: ${promptPath}`);
  }
  return fs.readFileSync(promptPath, 'utf-8');
}

function renderPrompt(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value || '');
  }
  return result;
}

module.exports = { loadPrompt, renderPrompt };
