/**
 * Keys the run itself owns in the run context. They ride beside the pipeline's
 * inputs and step outputs but are not either: `models` carries per-step model
 * overrides and `provider` the run's provider, both validated at the boundary
 * that accepts them. A step id or an input name in this set would let a step
 * output or a caller's `inputs` entry stand in for that validated value, so the
 * loader refuses both.
 */
export const RUN_CONTROL_KEYS = ["models", "provider"] as const;

export type RunControlKey = (typeof RUN_CONTROL_KEYS)[number];

export function isRunControlKey(name: string): name is RunControlKey {
  return (RUN_CONTROL_KEYS as readonly string[]).includes(name);
}
