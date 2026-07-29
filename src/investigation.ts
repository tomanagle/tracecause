import { Context, Effect, Layer } from "effect";
import type {
  Entity,
  EvidenceSource,
  InvestigationContext,
  IssueSource,
  NormalizedEvidence,
  SearchExecution,
  SearchIntent,
  TimelineEvent,
} from "./contracts.js";
import { evidenceSchema, issueSchema } from "./contracts.js";
import {
  EvidenceSearchError,
  IssueFetchError,
  ProviderContractError,
  type InvestigationError,
} from "./errors.js";
import { createCaseId, stableId } from "./ids.js";

export interface InvestigateOptions {
  reference: string;
  issueSource: IssueSource;
  evidenceSources: EvidenceSource[];
  caseId?: string;
  now?: () => Date;
  maxQueries?: number;
  maxDepth?: number;
  signal?: AbortSignal;
}

export type InvestigationInput = Omit<
  InvestigateOptions,
  "issueSource" | "evidenceSources" | "signal"
>;

export interface InvestigationResult {
  context: InvestigationContext;
  evidence: NormalizedEvidence[];
}

export class IssueSourceService extends Context.Service<
  IssueSourceService,
  IssueSource
>()("Tracecause/IssueSource") {}

export class EvidenceSourcesService extends Context.Service<
  EvidenceSourcesService,
  readonly EvidenceSource[]
>()("Tracecause/EvidenceSources") {}

export const makeProviderLayer = (
  issueSource: IssueSource,
  evidenceSources: readonly EvidenceSource[],
) =>
  Layer.mergeAll(
    Layer.succeed(IssueSourceService)(issueSource),
    Layer.succeed(EvidenceSourcesService)(evidenceSources),
  );

const specificity: Record<string, number> = {
  "cloudflare.ray_id": 1,
  "trace.id": 1,
  "request.id": 1,
  "correlation.id": 1,
  "project.id": 0.85,
  "customer.id": 0.65,
};

const windowFor = (
  entity: Entity,
  occurredAt: string,
): { from: string; to: string; mode: SearchIntent["mode"] } => {
  const anchor = new Date(occurredAt).getTime();
  const before =
    entity.role === "subject"
      ? 60 * 60_000
      : entity.role === "resource"
        ? 30 * 60_000
        : 5 * 60_000;
  return {
    from: new Date(anchor - before).toISOString(),
    to: new Date(anchor + 5 * 60_000).toISOString(),
    mode:
      entity.role === "subject" || entity.role === "resource"
        ? "related-history"
        : "exact",
  };
};

const candidateKey = (
  sourceId: string,
  entity: Entity,
  range: ReturnType<typeof windowFor>,
): string =>
  [sourceId, entity.kind, entity.canonicalValue, range.from, range.to, range.mode].join(
    "|",
  );

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
};

const validateIssue = Effect.fn("Provider.validateIssue")(function* (
  providerId: string,
  input: unknown,
) {
  const result = issueSchema.safeParse(input);
  if (!result.success) {
    return yield* Effect.fail(
      new ProviderContractError({
        providerId,
        contract: "issue",
        cause: result.error,
      }),
    );
  }
  return result.data;
});

const validateEvidence = Effect.fn("Provider.validateEvidence")(function* (
  providerId: string,
  records: unknown[],
) {
  return yield* Effect.forEach(records, (record) => {
    const result = evidenceSchema.safeParse(record);
    return result.success
      ? Effect.succeed(result.data)
      : Effect.fail(
          new ProviderContractError({
            providerId,
            contract: "evidence",
            cause: result.error,
          }),
        );
  });
});

const sanitizeForPersistence = (
  evidence: NormalizedEvidence[],
  entities: Entity[],
  searches: SearchExecution[],
): {
  evidence: NormalizedEvidence[];
  entities: Entity[];
  searches: SearchExecution[];
} => {
  const aliases = new Map<string, string>();
  const counters = new Map<string, number>();

  const sanitizeEntity = (item: Entity): Entity => {
    if (item.sensitivity !== "personal") return item;
    const key = `${item.kind}:${item.canonicalValue}`;
    let alias = aliases.get(key);
    if (alias === undefined) {
      const prefix = item.kind.split(".")[0] ?? "entity";
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      alias = `${prefix}_${next}`;
      aliases.set(key, alias);
    }
    return {
      ...item,
      value: alias,
      canonicalValue: alias,
    };
  };

  const sanitizedEntities = entities.map(sanitizeEntity);
  const sanitizedEvidence = evidence.map((record) => ({
    ...record,
    entities: record.entities.map(sanitizeEntity),
  }));
  const sanitizedSearches = searches.map((execution) => {
    const matched = entities.find(
      (item) =>
        item.kind === execution.intent.entity.kind &&
        item.canonicalValue === execution.intent.entity.value,
    );
    if (matched?.sensitivity !== "personal") return execution;
    const safeEntity = sanitizeEntity(matched);
    return {
      ...execution,
      intent: {
        ...execution.intent,
        entity: {
          kind: execution.intent.entity.kind,
          value: safeEntity.canonicalValue,
        },
      },
    };
  });
  return {
    evidence: sanitizedEvidence,
    entities: sanitizedEntities,
    searches: sanitizedSearches,
  };
};

const buildTimeline = (evidence: NormalizedEvidence[]): TimelineEvent[] =>
  evidence
    .filter((record) => record.sourceType !== "issue")
    .toSorted((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map((record) => {
      const event: TimelineEvent = {
        id: stableId("tl", record.id),
        timestamp: record.timestamp,
        title: record.level === "error" ? "Application error" : "Application event",
        summary: record.message ?? "Structured event",
        evidenceIds: [record.id],
        entityIds: record.entities.map((item) => item.id),
        confidence: 1,
      };
      if (record.service !== undefined) {
        event.service = record.service;
      }
      return event;
    });

export const investigateEffect: (
  options: InvestigationInput,
) => Effect.Effect<
  InvestigationResult,
  InvestigationError,
  IssueSourceService | EvidenceSourcesService
> = Effect.fn("Investigation.run")(function* (
  options: InvestigationInput,
): Effect.fn.Return<
  InvestigationResult,
  InvestigationError,
  IssueSourceService | EvidenceSourcesService
> {
  const issueSource = yield* IssueSourceService;
  const evidenceSources = yield* EvidenceSourcesService;
  const caseId = options.caseId ?? createCaseId();
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();

  const rawIssue = yield* Effect.tryPromise({
    try: (signal) => issueSource.fetchIssue(options.reference, { caseId, signal }),
    catch: (cause) => new IssueFetchError({ reference: options.reference, cause }),
  });
  const issue = yield* validateIssue(issueSource.id, rawIssue);

  const evidenceByFingerprint = new Map<string, NormalizedEvidence>();
  const entitiesByKey = new Map<string, Entity>();
  const searches: SearchExecution[] = [];
  const searched = new Set<string>();
  let frontier: Array<{ entity: Entity; depth: number }> = [];

  const ingest = (records: NormalizedEvidence[], depth: number): number => {
    let accepted = 0;
    for (const record of records) {
      if (evidenceByFingerprint.has(record.fingerprint)) continue;
      evidenceByFingerprint.set(record.fingerprint, record);
      accepted += 1;
      for (const discovered of record.entities) {
        const key = `${discovered.kind}:${discovered.canonicalValue}`;
        if (entitiesByKey.has(key)) continue;
        entitiesByKey.set(key, discovered);
        if (discovered.sensitivity !== "secret" && depth <= (options.maxDepth ?? 4)) {
          frontier.push({ entity: discovered, depth });
        }
      }
    }
    frontier = frontier.toSorted(
      (left, right) =>
        (specificity[right.entity.kind] ?? 0.2) -
        (specificity[left.entity.kind] ?? 0.2),
    );
    return accepted;
  };

  ingest(issue.evidence, 0);
  const maxQueries = options.maxQueries ?? 20;
  const maxDepth = options.maxDepth ?? 4;
  let completionReason: InvestigationContext["completion"]["reason"] =
    "frontier-exhausted";

  while (frontier.length > 0) {
    if (searches.length >= maxQueries) {
      completionReason = "max-queries";
      break;
    }
    const candidate = frontier.shift();
    if (candidate === undefined) break;
    if (candidate.depth > maxDepth) {
      completionReason = "max-depth";
      continue;
    }
    const range = windowFor(candidate.entity, issue.occurredAt);
    const source = evidenceSources.find((item) => {
      const provisional: SearchIntent = {
        id: "candidate",
        sourceId: item.id,
        entity: {
          kind: candidate.entity.kind,
          value: candidate.entity.canonicalValue,
        },
        timeRange: { from: range.from, to: range.to },
        mode: range.mode,
        limit: 100,
        depth: candidate.depth,
        reason: "candidate support check",
        causedByEvidenceIds: [candidate.entity.discoveredFromEvidenceId],
      };
      return item.supports(provisional);
    });
    if (source === undefined) continue;
    const key = candidateKey(source.id, candidate.entity, range);
    if (searched.has(key)) continue;
    searched.add(key);

    const intent: SearchIntent = {
      id: stableId("sq", key),
      sourceId: source.id,
      entity: {
        kind: candidate.entity.kind,
        value: candidate.entity.canonicalValue,
      },
      timeRange: { from: range.from, to: range.to },
      mode: range.mode,
      limit: 100,
      depth: candidate.depth,
      reason: `Search ${candidate.entity.kind} discovered in ${candidate.entity.discoveredFromEvidenceId}.`,
      causedByEvidenceIds: [candidate.entity.discoveredFromEvidenceId],
    };
    const startedAt = now().toISOString();
    const rawRecords = yield* Effect.tryPromise({
      try: (signal) => collect(source.search(intent, { caseId, signal })),
      catch: (cause) =>
        new EvidenceSearchError({
          sourceId: source.id,
          intentId: intent.id,
          cause,
        }),
    });
    const records = yield* validateEvidence(source.id, rawRecords);
    const accepted = ingest(records, candidate.depth + 1);
    searches.push({
      intent,
      providerQuerySummary: `${intent.mode} ${intent.entity.kind} in explicit time range`,
      startedAt,
      completedAt: now().toISOString(),
      status: "completed",
      recordsRead: records.length,
      recordsAccepted: accepted,
    });
  }

  const evidence = [...evidenceByFingerprint.values()];
  const entities = [...entitiesByKey.values()];
  const sanitized = sanitizeForPersistence(evidence, entities, searches);
  const timeline = buildTimeline(sanitized.evidence);
  const errorEvidence = evidence.filter((record) => record.level === "error");
  const updatedAt = now().toISOString();
  const context = {
    schemaVersion: "1",
    caseId,
    createdAt,
    updatedAt,
    issue,
    summary: {
      title: issue.title,
      evidenceCount: evidence.length,
      searchCount: searches.length,
    },
    timeline,
    entities: sanitized.entities,
    facts: [
      {
        statement: `The investigation found ${evidence.length} distinct evidence records.`,
        evidenceIds: evidence.map((record) => record.id),
      },
      ...errorEvidence.map((record) => ({
        statement: record.message ?? "An error was recorded.",
        evidenceIds: [record.id],
      })),
    ],
    hypotheses: [],
    gaps: [
      {
        description:
          "The fixture investigation does not yet resolve stack frames against the local repository.",
      },
    ],
    searches: sanitized.searches,
    evidenceReferences: sanitized.evidence.map((record) => ({
      id: record.id,
      providerId: record.source.providerId,
      externalId: record.source.externalId,
    })),
    completion: { reason: completionReason },
  } satisfies InvestigationContext;
  return { context, evidence: sanitized.evidence };
});

export const investigate = (
  options: InvestigateOptions,
): Promise<InvestigationResult> => {
  const layer = makeProviderLayer(options.issueSource, options.evidenceSources);
  const program = investigateEffect({
    reference: options.reference,
    ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxQueries === undefined ? {} : { maxQueries: options.maxQueries }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  }).pipe(Effect.provide(layer));
  return Effect.runPromise(program, { signal: options.signal });
};
