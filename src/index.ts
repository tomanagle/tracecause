export * from "./contracts.js";
export * from "./errors.js";
export * from "./investigation.js";
export * from "./providers/cloudflare.js";
export * from "./providers/sentry.js";

export interface RootcauseConfig {
  issueSources: unknown[];
  evidenceSources: unknown[];
  investigation?: {
    maxDepth?: number;
    maxQueries?: number;
  };
  redaction?: {
    mode: "strict";
    retainRawEvidence: boolean;
  };
}

export const defineConfig = <Config extends RootcauseConfig>(config: Config): Config =>
  config;
