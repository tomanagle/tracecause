import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { InitializationError } from "./errors.js";

const config = `import { defineConfig } from "tracecause";

export default defineConfig({
  issueSources: [],
  evidenceSources: [],
  investigation: {
    maxDepth: 4,
    maxQueries: 20,
  },
  redaction: {
    mode: "strict",
    retainRawEvidence: false,
  },
});
`;

const policies = `schemaVersion: "1"
search:
  denyEntityKinds:
    - network.ip
`;

const knowledge = `schemaVersion: "1"
services: {}
entityFields: {}
mappings: []
`;

const initOperation = <Value>(
  path: string,
  operation: () => Promise<Value>,
): Effect.Effect<Value, InitializationError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new InitializationError({ path, cause }),
  });

export const initializeRepositoryEffect = Effect.fn("Repository.initialize")(function* (
  root: string,
): Effect.fn.Return<void, InitializationError> {
  const directory = join(root, ".tracecause");
  yield* Effect.all(
    [
      initOperation(join(directory, "cases"), () =>
        mkdir(join(directory, "cases"), { recursive: true }),
      ),
      initOperation(join(directory, "state"), () =>
        mkdir(join(directory, "state"), { recursive: true }),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
  yield* Effect.all(
    [
      initOperation(join(directory, "config.ts"), () =>
        writeFile(join(directory, "config.ts"), config, {
          encoding: "utf8",
          flag: "wx",
        }),
      ),
      initOperation(join(directory, "policies.yaml"), () =>
        writeFile(join(directory, "policies.yaml"), policies, {
          encoding: "utf8",
          flag: "wx",
        }),
      ),
      initOperation(join(directory, "knowledge.yaml"), () =>
        writeFile(join(directory, "knowledge.yaml"), knowledge, {
          encoding: "utf8",
          flag: "wx",
        }),
      ),
      initOperation(join(directory, ".gitignore"), () =>
        writeFile(join(directory, ".gitignore"), "cases/\nstate/\n", {
          encoding: "utf8",
          flag: "wx",
        }),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

export const initializeRepository = (root: string): Promise<void> =>
  Effect.runPromise(initializeRepositoryEffect(root));
