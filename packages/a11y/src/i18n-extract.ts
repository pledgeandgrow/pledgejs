export interface TranslationEntry {
  key: string;
  value: string;
  file: string;
  line: number;
}

export interface ExtractionOptions {
  /** Function names to extract (default: ['t', 'translate']) */
  functionNames?: string[];
  /** Component names to extract (default: ['Trans', 'FormattedMessage']) */
  componentNames?: string[];
  /** File extensions to scan (default: ['.tsx', '.ts', '.jsx', '.js']) */
  extensions?: string[];
}

const ICU_MESSAGE_PATTERN = /\{(\w+),\s*(\w+)(?:,\s*(.+?))?\}/g;

export function extractTranslations(
  source: string,
  filePath: string,
  options: ExtractionOptions = {},
): TranslationEntry[] {
  const {
    functionNames = ['t', 'translate'],
    componentNames = ['Trans', 'FormattedMessage'],
  } = options;

  const entries: TranslationEntry[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const fn of functionNames) {
      const escapedFn = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        // (?<![\w$]): a call must start at an identifier boundary, otherwise `t(`
        // also matches the tail of `split('a')` or `format('x')`.
        new RegExp(`(?<![\\w$])${escapedFn}\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g'),
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          entries.push({
            key: match[1],
            value: match[1],
            file: filePath,
            line: i + 1,
          });
        }
      }
    }

    for (const comp of componentNames) {
      const escapedComp = comp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`<${escapedComp}[^>]*>\\s*([^<]+)\\s*</${escapedComp}>`, 'g');
      let match;
      while ((match = pattern.exec(line)) !== null) {
        entries.push({
          key: match[1].trim(),
          value: match[1].trim(),
          file: filePath,
          line: i + 1,
        });
      }
    }
  }

  return entries;
}

export function validateICUMessage(message: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  ICU_MESSAGE_PATTERN.lastIndex = 0;

  let match;
  while ((match = ICU_MESSAGE_PATTERN.exec(message)) !== null) {
    const [, name, type, style] = match;
    const validTypes = ['number', 'date', 'time', 'plural', 'selectordinal', 'select'];
    if (!validTypes.includes(type)) {
      errors.push(`Invalid ICU type "${type}" for argument "${name}"`);
    }
    if ((type === 'plural' || type === 'selectordinal') && !style) {
      errors.push(`Plural argument "${name}" requires format options`);
    }
  }

  return { valid: errors.length === 0, errors };
}
