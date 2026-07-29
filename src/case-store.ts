import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import type { InvestigationContext, NormalizedEvidence } from "./contracts.js";
import { CaseWriteError } from "./errors.js";
import { renderContextMarkdown, serializeEvidence } from "./reporter.js";

export interface WrittenCase {
  directory: string;
}

const fileOperation = <Value>(
  path: string,
  operation: () => Promise<Value>,
): Effect.Effect<Value, CaseWriteError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new CaseWriteError({ path, cause }),
  });

export const writeCaseEffect: (
  root: string,
  context: InvestigationContext,
  evidence: NormalizedEvidence[],
) => Effect.Effect<WrittenCase, CaseWriteError> = Effect.fn("CaseStore.write")(
  function* (
    root: string,
    context: InvestigationContext,
    evidence: NormalizedEvidence[],
  ): Effect.fn.Return<WrittenCase, CaseWriteError> {
    const casesDirectory = join(root, ".rootcause", "cases");
    const finalDirectory = join(casesDirectory, context.caseId);
    const temporaryDirectory = join(
      casesDirectory,
      `.${context.caseId}.tmp-${process.pid}`,
    );

    const temporaryCase = Effect.acquireRelease(
      fileOperation(temporaryDirectory, () =>
        mkdir(temporaryDirectory, { recursive: true }).then(() => temporaryDirectory),
      ),
      () =>
        Effect.tryPromise(() =>
          rm(temporaryDirectory, { force: true, recursive: true }),
        ).pipe(Effect.ignore),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* temporaryCase;
        yield* Effect.all(
          [
            fileOperation(join(temporaryDirectory, "context.md"), () =>
              writeFile(
                join(temporaryDirectory, "context.md"),
                renderContextMarkdown(context),
                "utf8",
              ),
            ),
            fileOperation(join(temporaryDirectory, "context.json"), () =>
              writeFile(
                join(temporaryDirectory, "context.json"),
                `${JSON.stringify(context, null, 2)}\n`,
                "utf8",
              ),
            ),
            fileOperation(join(temporaryDirectory, "timeline.json"), () =>
              writeFile(
                join(temporaryDirectory, "timeline.json"),
                `${JSON.stringify(context.timeline, null, 2)}\n`,
                "utf8",
              ),
            ),
            fileOperation(join(temporaryDirectory, "entities.json"), () =>
              writeFile(
                join(temporaryDirectory, "entities.json"),
                `${JSON.stringify(context.entities, null, 2)}\n`,
                "utf8",
              ),
            ),
            fileOperation(join(temporaryDirectory, "queries.ndjson"), () =>
              writeFile(
                join(temporaryDirectory, "queries.ndjson"),
                `${context.searches.map((search) => JSON.stringify(search)).join("\n")}\n`,
                "utf8",
              ),
            ),
            fileOperation(join(temporaryDirectory, "evidence.ndjson"), () =>
              writeFile(
                join(temporaryDirectory, "evidence.ndjson"),
                serializeEvidence(evidence),
                "utf8",
              ),
            ),
            fileOperation(join(temporaryDirectory, "metadata.json"), () =>
              writeFile(
                join(temporaryDirectory, "metadata.json"),
                `${JSON.stringify(
                  {
                    schemaVersion: "1",
                    caseId: context.caseId,
                    createdAt: context.createdAt,
                    updatedAt: context.updatedAt,
                    completion: context.completion,
                  },
                  null,
                  2,
                )}\n`,
                "utf8",
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );

        yield* fileOperation(dirname(finalDirectory), () =>
          mkdir(dirname(finalDirectory), { recursive: true }),
        );
        yield* fileOperation(finalDirectory, () =>
          rename(temporaryDirectory, finalDirectory),
        );
        return { directory: finalDirectory };
      }),
    );
  },
);
