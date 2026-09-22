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
/** What a model entry resolves to, shown in the picker (spec 042 D20). */
export declare function modelLabel(entry: Record<string, unknown>): string;
/** One line for a column header: plan, else auth method, else why not (042 D23). */
export declare function accountLabel(
  account: { plan?: string; authMethod?: string; error?: string } | undefined
): string;
/** Which provider a model entry belongs to, derived from the entry (042 D22). */
export declare function modelVendor(
  entry: Record<string, unknown>
): "anthropic" | "openai" | "local" | "other";
/** The vendor a profile column is for, read from the models it already uses. */
export declare function columnVendor(
  column: Record<string, unknown>,
  models: Record<string, unknown>[]
): string | undefined;
/** The options of one role cell, with the current value always kept. */
export declare function modelOptions(
  models: Record<string, unknown>[],
  current: string,
  vendor?: string
): string;
export declare function renderProviderMatrix(
  columns: ProviderColumn[],
  opts?: {
    models?: Record<string, unknown>[];
    accounts?: Record<string, Record<string, unknown>>;
    activeProfile?: string;
  }
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
