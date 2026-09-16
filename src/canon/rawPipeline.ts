// Reading a pipeline YAML without validating it.
//
// The merge (layers.ts), the fork (fork.ts) and the export closure
// (bundle/closure.ts) each need one or two declared fields of a file that may
// not be a valid pipeline at all — a file that fails validation still has to
// take part in the merge and still has an id. They share the parse, not the
// traversal: what each walks afterwards is deliberately different.

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface RawStep {
  kind?: string;
  prompt?: string;
  pipeline?: string;
}

export interface RawPipeline {
  id?: string;
  steps?: RawStep[];
}

/** Parse `filePath` as YAML. An empty file reads as a pipeline with no fields. */
export function readRawPipeline(filePath: string): RawPipeline {
  return (parse(readFileSync(filePath, "utf8")) as RawPipeline | null) ?? {};
}
