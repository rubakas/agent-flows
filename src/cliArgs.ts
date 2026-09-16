// Argument reading shared by the verb entry points.
//
// Each verb module is handed the arguments after its own name by the router, so
// every one of them starts from `process.argv.slice(2)` and reads it the same
// way.

/** The value following `--name`, or undefined when `--name` is not present. */
export function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/** Whether `--name` is present at all. */
export function flag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}
