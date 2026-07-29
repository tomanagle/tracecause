import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  knowledgeMappingSchema,
  type InvestigationContext,
  type KnowledgeMapping,
  type NormalizedEvidence,
} from "./contracts.js";
import { stableId } from "./ids.js";

const knowledgeDocumentSchema = z
  .object({
    schemaVersion: z.literal("1"),
    services: z.record(z.string(), z.unknown()).default({}),
    entityFields: z.record(z.string(), z.unknown()).default({}),
    mappings: z.array(knowledgeMappingSchema).default([]),
  })
  .strict();

const observationsDocumentSchema = z
  .object({
    schemaVersion: z.literal("1"),
    mappings: z.array(knowledgeMappingSchema).default([]),
  })
  .strict();

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type ObservationsDocument = z.infer<typeof observationsDocumentSchema>;

const emptyKnowledge = (): KnowledgeDocument => ({
  schemaVersion: "1",
  services: {},
  entityFields: {},
  mappings: [],
});

const emptyObservations = (): ObservationsDocument => ({
  schemaVersion: "1",
  mappings: [],
});

export class KnowledgeStoreError extends Data.TaggedError("KnowledgeStoreError")<{
  readonly operation: "load" | "observe" | "promote" | "forget";
  readonly path: string;
  readonly cause: unknown;
}> {}

const knowledgePath = (root: string): string =>
  join(root, ".tracecause", "knowledge.yaml");
const observationsPath = (root: string): string =>
  join(root, ".tracecause", "state", "observations.json");

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const readKnowledge = async (root: string): Promise<KnowledgeDocument> => {
  try {
    return knowledgeDocumentSchema.parse(
      parse(await readFile(knowledgePath(root), "utf8")),
    );
  } catch (cause) {
    if (isMissingFile(cause)) return emptyKnowledge();
    throw cause;
  }
};

const readObservations = async (root: string): Promise<ObservationsDocument> => {
  try {
    return observationsDocumentSchema.parse(
      JSON.parse(await readFile(observationsPath(root), "utf8")),
    );
  } catch (cause) {
    if (isMissingFile(cause)) return emptyObservations();
    throw cause;
  }
};

const atomicWrite = async (path: string, contents: string): Promise<void> => {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const providerNodeType = (providerId: string): string | undefined => {
  if (providerId === "cloudflare-workers") return "cloudflare.service";
  if (providerId === "aws-cloudwatch") return "cloudwatch.service";
  return undefined;
};

const mappingId = (
  from: KnowledgeMapping["from"],
  to: KnowledgeMapping["to"],
): string => stableId("km", `${from.type}:${from.key}|${to.type}:${to.key}`);

export const deriveStructuralMappings = (
  context: InvestigationContext,
  evidence: NormalizedEvidence[],
  observedAt = context.updatedAt,
): KnowledgeMapping[] => {
  if (context.issue.service === undefined) return [];
  const from = { type: "sentry.project", key: context.issue.service };
  const targets = new Map<string, KnowledgeMapping["to"]>();
  for (const record of evidence) {
    const type = providerNodeType(record.source.providerId);
    if (type === undefined || record.service === undefined) continue;
    const to = { type, key: record.service };
    targets.set(`${to.type}:${to.key}`, to);
  }
  return [...targets.values()].map((to) => ({
    schemaVersion: "1",
    id: mappingId(from, to),
    kind: "service.correspondence",
    from,
    to,
    confidence: 0.5,
    confirmationCount: 1,
    firstObservedAt: observedAt,
    lastConfirmedAt: observedAt,
    provenance: [
      {
        caseId: context.caseId,
        observationType: "correlated_service_evidence",
      },
    ],
    status: "observed",
  }));
};

export const loadConfirmedKnowledgeEffect = Effect.fn("Knowledge.loadConfirmed")(
  function* (root: string) {
    const path = knowledgePath(root);
    const document = yield* Effect.tryPromise({
      try: () => readKnowledge(root),
      catch: (cause) => new KnowledgeStoreError({ operation: "load", path, cause }),
    });
    return document.mappings.filter((mapping) => mapping.status === "confirmed");
  },
);

export const recordKnowledgeObservationsEffect = Effect.fn("Knowledge.observe")(
  function* (
    root: string,
    context: InvestigationContext,
    evidence: NormalizedEvidence[],
  ) {
    const path = observationsPath(root);
    const observations = yield* Effect.tryPromise({
      try: () => readObservations(root),
      catch: (cause) => new KnowledgeStoreError({ operation: "observe", path, cause }),
    });
    const derived = deriveStructuralMappings(context, evidence);
    const byId = new Map(observations.mappings.map((mapping) => [mapping.id, mapping]));
    for (const candidate of derived) {
      const existing = byId.get(candidate.id);
      if (existing === undefined) {
        byId.set(candidate.id, candidate);
        continue;
      }
      const hasCase = existing.provenance.some(
        (item) => item.caseId === context.caseId,
      );
      if (hasCase) continue;
      const confirmationCount = existing.confirmationCount + 1;
      byId.set(candidate.id, {
        ...existing,
        confidence: Math.min(0.9, 0.5 + confirmationCount * 0.1),
        confirmationCount,
        lastConfirmedAt: context.updatedAt,
        provenance: [...existing.provenance, ...candidate.provenance],
      });
    }
    const next = {
      schemaVersion: "1",
      mappings: [...byId.values()].toSorted((left, right) =>
        left.id.localeCompare(right.id),
      ),
    } satisfies ObservationsDocument;
    yield* Effect.tryPromise({
      try: () => atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`),
      catch: (cause) => new KnowledgeStoreError({ operation: "observe", path, cause }),
    });
    return derived.map((mapping) => mapping.id);
  },
);

export const showKnowledgeEffect = Effect.fn("Knowledge.show")(function* (
  root: string,
) {
  const path = knowledgePath(root);
  return yield* Effect.tryPromise({
    try: () => readKnowledge(root),
    catch: (cause) => new KnowledgeStoreError({ operation: "load", path, cause }),
  });
});

export const inspectKnowledgeEffect = Effect.fn("Knowledge.inspect")(function* (
  root: string,
) {
  const knowledge = yield* showKnowledgeEffect(root);
  const path = observationsPath(root);
  const observations = yield* Effect.tryPromise({
    try: () => readObservations(root),
    catch: (cause) => new KnowledgeStoreError({ operation: "load", path, cause }),
  });
  return { reviewed: knowledge.mappings, observations: observations.mappings };
});

export const validateKnowledgeEffect = Effect.fn("Knowledge.validate")(function* (
  root: string,
) {
  const knowledge = yield* showKnowledgeEffect(root);
  const path = observationsPath(root);
  const observations = yield* Effect.tryPromise({
    try: () => readObservations(root),
    catch: (cause) => new KnowledgeStoreError({ operation: "load", path, cause }),
  });
  return {
    confirmed: knowledge.mappings.length,
    observations: observations.mappings.length,
  };
});

export const promoteKnowledgeEffect = Effect.fn("Knowledge.promote")(function* (
  root: string,
) {
  const knowledge = yield* showKnowledgeEffect(root);
  const statePath = observationsPath(root);
  const observations = yield* Effect.tryPromise({
    try: () => readObservations(root),
    catch: (cause) =>
      new KnowledgeStoreError({
        operation: "promote",
        path: statePath,
        cause,
      }),
  });
  const byId = new Map(knowledge.mappings.map((mapping) => [mapping.id, mapping]));
  for (const observation of observations.mappings) {
    byId.set(observation.id, { ...observation, status: "confirmed" });
  }
  const next = {
    ...knowledge,
    mappings: [...byId.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  yield* Effect.tryPromise({
    try: async () => {
      await atomicWrite(knowledgePath(root), stringify(next, { lineWidth: 0 }));
      await atomicWrite(statePath, `${JSON.stringify(emptyObservations(), null, 2)}\n`);
    },
    catch: (cause) =>
      new KnowledgeStoreError({
        operation: "promote",
        path: knowledgePath(root),
        cause,
      }),
  });
  return observations.mappings.length;
});

export const forgetKnowledgeEffect = Effect.fn("Knowledge.forget")(function* (
  root: string,
  id: string,
) {
  const knowledge = yield* showKnowledgeEffect(root);
  const observations = yield* Effect.tryPromise({
    try: () => readObservations(root),
    catch: (cause) =>
      new KnowledgeStoreError({
        operation: "forget",
        path: observationsPath(root),
        cause,
      }),
  });
  const nextKnowledge = {
    ...knowledge,
    mappings: knowledge.mappings.filter((mapping) => mapping.id !== id),
  };
  const nextObservations = {
    ...observations,
    mappings: observations.mappings.filter((mapping) => mapping.id !== id),
  };
  const removed =
    nextKnowledge.mappings.length !== knowledge.mappings.length ||
    nextObservations.mappings.length !== observations.mappings.length;
  yield* Effect.tryPromise({
    try: async () => {
      await atomicWrite(
        knowledgePath(root),
        stringify(nextKnowledge, { lineWidth: 0 }),
      );
      await atomicWrite(
        observationsPath(root),
        `${JSON.stringify(nextObservations, null, 2)}\n`,
      );
    },
    catch: (cause) =>
      new KnowledgeStoreError({
        operation: "forget",
        path: knowledgePath(root),
        cause,
      }),
  });
  return removed;
});
