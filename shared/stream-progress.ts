/**
 * Live compile progress (§10 streaming). While the model generates, the
 * server forwards two honest signals: the headlines of the model's own
 * reasoning summary, and each operation as soon as its JSON object is
 * complete. Nothing here is validated or applied — the finished result still
 * goes through strict parsing and the engine before the author sees a preview.
 */

/** Bold headings ("**Planning the Structure**") from reasoning summaries. */
export function reasoningHeadlines(text: string): string[] {
  const headlines: string[] = [];
  for (const match of text.matchAll(/\*\*([^*\n]{3,80})\*\*/g)) {
    const headline = match[1]!.trim();
    if (headline.length > 0 && !headlines.includes(headline)) headlines.push(headline);
  }
  return headlines;
}

/**
 * Incrementally finds complete objects inside the streamed "operations"
 * array. It tracks strings and escapes, so braces inside labels or rationale
 * text never confuse it; a malformed stream simply yields nothing.
 */
export class OperationStream {
  private text = '';
  private scanFrom = 0;
  private arrayStart = -1;
  private depth = 0;
  private objectStart = -1;
  private inString = false;
  private escaped = false;

  push(chunk: string): unknown[] {
    this.text += chunk;
    const found: unknown[] = [];
    if (this.arrayStart < 0) {
      const key = this.text.indexOf('"operations"');
      if (key < 0) return found;
      const bracket = this.text.indexOf('[', key);
      if (bracket < 0) return found;
      this.arrayStart = bracket;
      this.scanFrom = bracket + 1;
    }
    for (let i = this.scanFrom; i < this.text.length; i++) {
      const char = this.text[i]!;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') {
        this.inString = true;
      } else if (char === '{') {
        if (this.depth === 0) this.objectStart = i;
        this.depth += 1;
      } else if (char === '}') {
        this.depth -= 1;
        if (this.depth === 0 && this.objectStart >= 0) {
          try {
            found.push(JSON.parse(this.text.slice(this.objectStart, i + 1)));
          } catch {
            // An unparsable fragment is skipped; the final strict parse decides.
          }
          this.objectStart = -1;
        }
      } else if (char === ']' && this.depth === 0) {
        this.scanFrom = this.text.length;
        this.arrayStart = Number.POSITIVE_INFINITY;
        return found;
      }
    }
    this.scanFrom = this.text.length;
    return found;
  }
}

function field(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'string' ? entry : undefined;
}

function human(id: string | undefined): string {
  return (id ?? '').replace(/-/g, ' ');
}

/** A short, unvalidated label for a streamed operation ("+ ramp: tower stair"). */
export function operationLabel(operation: unknown): string {
  const kind = field(operation, 'kind');
  const module = operation !== null && typeof operation === 'object' ? (operation as Record<string, unknown>).module : undefined;
  const door = operation !== null && typeof operation === 'object' ? (operation as Record<string, unknown>).door : undefined;
  switch (kind) {
    case 'addModule':
      return `+ ${field(module, 'template') ?? 'platform'}: ${human(field(module, 'label') ?? field(module, 'id'))}`;
    case 'removeModule':
      return `− platform: ${human(field(operation, 'id'))}`;
    case 'moveModule':
      return `→ move ${human(field(operation, 'id'))}`;
    case 'setModulePorts':
      return `→ exits of ${human(field(operation, 'id'))}`;
    case 'setModuleLabel':
      return `→ name “${field(operation, 'label') ?? ''}”`;
    case 'addItem':
      return `+ ${field(operation, 'itemType') ?? 'item'}: ${human(field(operation, 'id'))}`;
    case 'moveItem':
      return `→ move ${human(field(operation, 'id'))}`;
    case 'removeItem':
      return `− ${human(field(operation, 'id'))}`;
    case 'moveSpawn':
      return '→ player start';
    case 'moveGoal':
      return '→ goal';
    case 'addDoor':
      return `+ door: ${human(field(door, 'id'))}`;
    case 'setDoorConditions':
      return `→ rules of ${human(field(operation, 'id'))}`;
    case 'removeDoor':
      return `− door: ${human(field(operation, 'id'))}`;
    case 'setScenery':
      return `✦ scenery: ${[field(operation, 'environment'), field(operation, 'lighting'), field(operation, 'architecture')].filter(Boolean).join(', ')}`;
    case 'addProp':
      return `✦ ${human(field(operation, 'prop'))}: ${human(field(operation, 'id'))}`;
    case 'moveProp':
    case 'removeProp':
      return `✦ ${human(field(operation, 'id'))}`;
    case 'setKeyLook':
      return `✦ ${human(field(operation, 'id'))} looks like a ${field(operation, 'look') ?? 'key'}`;
    default:
      return '· operation';
  }
}
