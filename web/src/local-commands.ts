export interface ModelCommand {
  pattern?: string;
}

export function parseModelCommand(trimmedText: string): ModelCommand | undefined {
  if (trimmedText === "/model") return {};
  if (!trimmedText.startsWith("/model ")) return undefined;
  const pattern = trimmedText.slice("/model ".length).trim();
  return pattern ? { pattern } : {};
}

export interface NameCommand {
  title: string;
}

export function parseNameCommand(trimmedText: string): NameCommand | undefined {
  if (trimmedText !== "/name" && !trimmedText.startsWith("/name ")) return undefined;
  return { title: trimmedText.slice("/name".length).trim() };
}

export interface ModelChoice {
  provider: string;
  id: string;
  name?: string;
}

export type ModelResolution =
  | { kind: "match"; model: ModelChoice }
  | { kind: "ambiguous"; matches: ModelChoice[] }
  | { kind: "none" };

function candidateStrings(model: ModelChoice): string[] {
  const strings = [model.id, `${model.provider}/${model.id}`];
  if (model.name) strings.push(model.name);
  return strings.map((s) => s.toLowerCase());
}

export function resolveModelPattern(models: readonly ModelChoice[], pattern: string): ModelResolution {
  const needle = pattern.toLowerCase();
  const tiers = [
    models.filter((m) => candidateStrings(m).includes(needle)),
    models.filter((m) => candidateStrings(m).some((s) => s.startsWith(needle))),
    models.filter((m) => candidateStrings(m).some((s) => s.includes(needle))),
  ];
  for (const tier of tiers) {
    const only = tier.length === 1 ? tier[0] : undefined;
    if (only) return { kind: "match", model: only };
  }
  const matches = tiers.find((tier) => tier.length > 0);
  if (!matches) return { kind: "none" };
  return { kind: "ambiguous", matches };
}
