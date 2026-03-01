/**
 * Session template storage using localStorage.
 * Templates let users save and reuse common task configurations.
 */

export interface SessionTemplate {
  id: string;
  name: string;
  task: string;
  mode: string;
  agentic: boolean;
  createdAt: string;
  /** Built-in templates cannot be deleted */
  builtin?: boolean;
}

const STORAGE_KEY = "karnevil9_session_templates";

/** Built-in example templates shipped with the dashboard */
const BUILTIN_TEMPLATES: SessionTemplate[] = [
  {
    id: "builtin-quick-test",
    name: "Quick Test",
    task: "Run a quick diagnostic check and report the results.",
    mode: "mock",
    agentic: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    builtin: true,
  },
  {
    id: "builtin-research-task",
    name: "Research Task",
    task: "Research the following topic thoroughly, gathering information from multiple sources, synthesizing findings, and producing a structured report with key takeaways.",
    mode: "live",
    agentic: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    builtin: true,
  },
  {
    id: "builtin-code-review",
    name: "Code Review",
    task: "Review the specified code for correctness, security issues, performance concerns, and adherence to best practices. Provide actionable feedback.",
    mode: "live",
    agentic: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    builtin: true,
  },
];

/** Read all templates from localStorage, merging with built-ins */
export function getTemplates(): SessionTemplate[] {
  if (typeof window === "undefined") return [...BUILTIN_TEMPLATES];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const userTemplates: SessionTemplate[] = raw ? JSON.parse(raw) : [];
    // Built-ins first, then user templates sorted newest-first
    return [
      ...BUILTIN_TEMPLATES,
      ...userTemplates.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    ];
  } catch {
    return [...BUILTIN_TEMPLATES];
  }
}

/** Get user-only templates (excludes built-ins) */
function getUserTemplates(): SessionTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Persist user templates to localStorage */
function setUserTemplates(templates: SessionTemplate[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

/** Get a single template by ID (checks built-ins and user templates) */
export function getTemplate(id: string): SessionTemplate | undefined {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) return builtin;
  return getUserTemplates().find((t) => t.id === id);
}

/** Save a new template. Returns the saved template. */
export function saveTemplate(
  template: Omit<SessionTemplate, "id" | "createdAt">,
): SessionTemplate {
  const newTemplate: SessionTemplate = {
    ...template,
    id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  const existing = getUserTemplates();
  existing.push(newTemplate);
  setUserTemplates(existing);
  return newTemplate;
}

/** Update a template's name. Built-in templates cannot be edited. */
export function updateTemplateName(id: string, name: string): boolean {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) return false;
  const templates = getUserTemplates();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  templates[idx] = { ...templates[idx]!, name };
  setUserTemplates(templates);
  return true;
}

/** Delete a template by ID. Built-in templates cannot be deleted. Returns true if deleted. */
export function deleteTemplate(id: string): boolean {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) return false;
  const templates = getUserTemplates();
  const filtered = templates.filter((t) => t.id !== id);
  if (filtered.length === templates.length) return false;
  setUserTemplates(filtered);
  return true;
}
