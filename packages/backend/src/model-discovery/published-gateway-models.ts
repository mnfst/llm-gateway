const OPENCODE_GO = 'opencode-go';
const OPENCODE_GO_PREFIX = `${OPENCODE_GO}/`;

interface DocsCatalog {
  list(): Promise<{ id: string }[]>;
}

interface ModelsDevCatalog {
  getModelsForProvider(providerId: string): { id: string }[];
}

/** The shape this module needs off a picker row. */
export interface GatewayModelRow {
  model_name: string;
  provider: string;
  display_name?: string | null;
}

function isOpencodeGo(row: { provider: string }): boolean {
  return row.provider.toLowerCase() === OPENCODE_GO;
}

function bareId(modelName: string): string {
  return modelName.startsWith(OPENCODE_GO_PREFIX)
    ? modelName.slice(OPENCODE_GO_PREFIX.length)
    : modelName;
}

/** What the picker prints for a row, which is what a user sees collide. */
function label(row: GatewayModelRow): string {
  return row.display_name || row.model_name;
}

/**
 * The OpenCode Go model ids that either OpenCode's own docs or models.dev
 * publish. Empty when no OpenCode Go model is in play, or when neither catalog
 * loaded — callers treat an empty set as "no basis to judge".
 */
export async function publishedOpencodeGoIds(
  models: readonly { provider: string }[],
  docs: DocsCatalog | null,
  modelsDev: ModelsDevCatalog | null,
): Promise<Set<string>> {
  const published = new Set<string>();
  if (!models.some(isOpencodeGo)) return published;
  for (const entry of (await docs?.list()) ?? []) published.add(entry.id);
  for (const entry of modelsDev?.getModelsForProvider(OPENCODE_GO) ?? []) published.add(entry.id);
  return published;
}

/**
 * Hide an OpenCode Go model only when a published one already stands for it.
 *
 * `/models` is a superset of what OpenCode documents: it also answers to a
 * vendor's native id for a model it lists under its own. `deepseek-flash` is
 * DeepSeek's name for the model the docs call `deepseek-v4.1-flash`, and both
 * resolve to "DeepSeek V4.1 Flash", so the picker offered one model twice —
 * and the undocumented id has no docs row, so it carries no per-request quota
 * cost and its calls record as $0.
 *
 * The test is a name collision with a published id, not absence from the
 * catalogs. An id nothing publishes but nothing shadows either — `hy3-preview`
 * resolves to "Hy3 Preview" and is its own model — stays selectable. So does
 * anything genuinely new that no catalog has caught up with yet. Hiding on
 * absence alone would have cost users a model OpenCode really serves.
 *
 * **Selection only.** Discovery still caches every model, so a tier already
 * pinned to a hidden id keeps resolving: `ProviderKeyService.isRouteAvailable`
 * reads the discovered list, and dropping a model there would turn a working
 * override into an orphaned one and silently demote the tier to a fallback.
 */
export function dropShadowedGatewayModels<T extends GatewayModelRow>(
  rows: T[],
  published: ReadonlySet<string>,
): T[] {
  if (published.size === 0) return rows;

  const publishedLabels = new Set<string>();
  for (const row of rows) {
    if (isOpencodeGo(row) && published.has(bareId(row.model_name))) {
      publishedLabels.add(label(row));
    }
  }
  if (publishedLabels.size === 0) return rows;

  return rows.filter((row) => {
    if (!isOpencodeGo(row)) return true;
    if (published.has(bareId(row.model_name))) return true;
    return !publishedLabels.has(label(row));
  });
}
