/**
 * Returns every placeholder name found in a template string.
 * Uses the same pattern as `renderPrompt` so the two cannot diverge.
 */
export function extractPlaceholders(template: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;
  const re = /\{\{(\w+)\}\}/g;
  while ((m = re.exec(template)) !== null) {
    names.push(m[1]);
  }
  return names;
}

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in vars)) {
      throw new Error(`renderPrompt: no value provided for placeholder "{{${name}}}"`);
    }
    return vars[name];
  });
}
