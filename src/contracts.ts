import { z } from "zod";

export const entitySchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    role: z.enum([
      "correlation",
      "subject",
      "resource",
      "deployment",
      "service",
      "location",
      "custom",
    ]),
    value: z.string(),
    canonicalValue: z.string(),
    sensitivity: z.enum(["none", "internal", "personal", "secret"]),
    confidence: z.number().min(0).max(1),
    discoveredFromEvidenceId: z.string(),
    extractorId: z.string(),
  })
  .strict();

export type Entity = z.infer<typeof entitySchema>;

export const evidenceSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string(),
    source: z.object({
      providerId: z.string(),
      externalId: z.string(),
    }),
    sourceType: z.enum(["issue", "log", "trace", "deployment", "event"]),
    timestamp: z.string().datetime(),
    service: z.string().optional(),
    level: z.string().optional(),
    message: z.string().optional(),
    attributes: z.record(z.string(), z.json()),
    entities: z.array(entitySchema),
    fingerprint: z.string(),
    redactions: z.array(
      z.object({
        path: z.string(),
        reason: z.string(),
      }),
    ),
  })
  .strict();

export type NormalizedEvidence = z.infer<typeof evidenceSchema>;

export const issueSchema = z
  .object({
    schemaVersion: z.literal("1"),
    source: z.object({
      providerId: z.string(),
      externalId: z.string(),
      reference: z.string(),
    }),
    title: z.string(),
    message: z.string().optional(),
    occurredAt: z.string().datetime(),
    firstSeenAt: z.string().datetime().optional(),
    lastSeenAt: z.string().datetime().optional(),
    environment: z.string().optional(),
    release: z.string().optional(),
    service: z.string().optional(),
    stackFrames: z.array(
      z.object({
        filename: z.string(),
        function: z.string().optional(),
        lineNumber: z.number().int().positive().optional(),
        inApp: z.boolean().optional(),
      }),
    ),
    tags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    entities: z.array(entitySchema),
    evidence: z.array(evidenceSchema),
  })
  .strict();

export type NormalizedIssue = z.infer<typeof issueSchema>;

export const searchIntentSchema = z
  .object({
    id: z.string(),
    sourceId: z.string(),
    entity: z.object({
      kind: z.string(),
      value: z.string(),
    }),
    timeRange: z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
    }),
    mode: z.enum(["exact", "related-history", "full-text"]),
    limit: z.number().int().positive(),
    depth: z.number().int().nonnegative(),
    reason: z.string(),
    causedByEvidenceIds: z.array(z.string()),
  })
  .strict();

export type SearchIntent = z.infer<typeof searchIntentSchema>;

export const searchExecutionSchema = z
  .object({
    intent: searchIntentSchema,
    providerQuerySummary: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    status: z.enum(["completed", "failed", "skipped", "budget-exhausted"]),
    recordsRead: z.number().int().nonnegative(),
    recordsAccepted: z.number().int().nonnegative(),
  })
  .strict();

export type SearchExecution = z.infer<typeof searchExecutionSchema>;

export const timelineEventSchema = z
  .object({
    id: z.string(),
    timestamp: z.string().datetime(),
    service: z.string().optional(),
    title: z.string(),
    summary: z.string(),
    evidenceIds: z.array(z.string()),
    entityIds: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const investigationContextSchema = z
  .object({
    schemaVersion: z.literal("1"),
    caseId: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    issue: issueSchema,
    summary: z.object({
      title: z.string(),
      evidenceCount: z.number().int().nonnegative(),
      searchCount: z.number().int().nonnegative(),
    }),
    timeline: z.array(timelineEventSchema),
    entities: z.array(entitySchema),
    facts: z.array(
      z.object({
        statement: z.string(),
        evidenceIds: z.array(z.string()).min(1),
      }),
    ),
    hypotheses: z.array(
      z.object({
        statement: z.string(),
        evidenceIds: z.array(z.string()),
      }),
    ),
    gaps: z.array(z.object({ description: z.string() })),
    searches: z.array(searchExecutionSchema),
    evidenceReferences: z.array(
      z.object({
        id: z.string(),
        providerId: z.string(),
        externalId: z.string(),
      }),
    ),
    completion: z.object({
      reason: z.enum([
        "frontier-exhausted",
        "max-queries",
        "max-depth",
        "provider-failure",
      ]),
    }),
  })
  .strict();

export type InvestigationContext = z.infer<typeof investigationContextSchema>;

export interface ProviderContext {
  caseId: string;
  signal: AbortSignal;
}

export interface IssueSource {
  readonly id: string;
  canHandle(reference: string): boolean;
  fetchIssue(reference: string, context: ProviderContext): Promise<NormalizedIssue>;
}

export interface EvidenceSource {
  readonly id: string;
  supports(intent: SearchIntent): boolean;
  search(
    intent: SearchIntent,
    context: ProviderContext,
  ): AsyncIterable<NormalizedEvidence>;
}
