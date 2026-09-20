// Types for ui-providers.js. The provider editor ships as plain ESM so the
// browser can load it unbuilt from /ui-providers.js; this declaration lets the
// unit test import it without turning on allowJs for the whole project.

export declare const PROVIDER_ROLES: string[];

export interface ProviderColumn {
  id: string;
  roles: Record<string, string>;
  fallback: string[];
  source: "project" | "builtin";
  overridesBuiltIn: boolean;
  builtin: { roles: Record<string, string>; fallback: string[] } | null;
}

export declare function renderProviderNotices(state?: {
  restartRequired?: boolean;
  saved?: boolean;
}): string;
export declare function providerColumns(data: Record<string, unknown>): ProviderColumn[];
export declare function renderProviderMatrix(
  columns: ProviderColumn[],
  opts?: { modelIds?: string[]; activeProfile?: string }
): string;
export declare function renderProviderModels(
  project: Record<string, unknown>[],
  builtin?: Record<string, unknown>[]
): string;
export declare function collectProviderDocument(form: Record<string, unknown>): {
  document: Record<string, unknown>;
  profileIds: string[];
  modelIds: string[];
};
export declare function parseProviderError(message: string): {
  scope: string;
  index: number | null;
  field: string;
  reason: string;
};
