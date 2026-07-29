import type {
  Entity,
  EvidenceSource,
  IssueSource,
  NormalizedEvidence,
  NormalizedIssue,
  ProviderContext,
  SearchIntent,
} from "./contracts.js";
import { fingerprint, stableId } from "./ids.js";

const occurredAt = "2026-07-29T00:42:18.219Z";

const entity = (
  kind: string,
  role: Entity["role"],
  value: string,
  evidenceId: string,
  sensitivity: Entity["sensitivity"] = "none",
): Entity => ({
  id: stableId("en", `${kind}:${value}`),
  kind,
  role,
  value,
  canonicalValue: value.toLowerCase(),
  sensitivity,
  confidence: 1,
  discoveredFromEvidenceId: evidenceId,
  extractorId: "fixture.structured-fields",
});

const log = (input: {
  externalId: string;
  timestamp: string;
  message: string;
  level?: string;
  service?: string;
  entities: Array<{
    kind: string;
    role: Entity["role"];
    value: string;
    sensitivity?: Entity["sensitivity"];
  }>;
  attributes?: NormalizedEvidence["attributes"];
}): NormalizedEvidence => {
  const id = stableId("ev", `cloudflare:${input.externalId}`);
  const attributes = input.attributes ?? {};
  return {
    schemaVersion: "1",
    id,
    source: {
      providerId: "cloudflare-workers",
      externalId: input.externalId,
    },
    sourceType: "log",
    timestamp: input.timestamp,
    service: input.service ?? "api-production",
    level: input.level ?? "info",
    message: input.message,
    attributes,
    entities: input.entities.map((item) =>
      entity(item.kind, item.role, item.value, id, item.sensitivity ?? "none"),
    ),
    fingerprint: fingerprint({
      timestamp: input.timestamp,
      message: input.message,
      attributes,
    }),
    redactions: [],
  };
};

const fixtureLogs = [
  log({
    externalId: "cf-1",
    timestamp: "2026-07-29T00:42:17.900Z",
    message: "Project update request received",
    entities: [
      { kind: "cloudflare.ray_id", role: "correlation", value: "83f1d84d6d7a21ab" },
      { kind: "request.id", role: "correlation", value: "req_8348a" },
      {
        kind: "customer.id",
        role: "subject",
        value: "cus_9182",
        sensitivity: "personal",
      },
      { kind: "project.id", role: "resource", value: "prj_441" },
    ],
  }),
  log({
    externalId: "cf-2",
    timestamp: "2026-07-29T00:42:18.190Z",
    level: "error",
    message: "Project owner was missing during update",
    entities: [
      { kind: "request.id", role: "correlation", value: "req_8348a" },
      {
        kind: "customer.id",
        role: "subject",
        value: "cus_9182",
        sensitivity: "personal",
      },
      { kind: "project.id", role: "resource", value: "prj_441" },
    ],
    attributes: { ownerId: null, operation: "project.update" },
  }),
  log({
    externalId: "cf-3",
    timestamp: "2026-07-29T00:18:00.000Z",
    message: "Customer imported project without owner",
    entities: [
      {
        kind: "customer.id",
        role: "subject",
        value: "cus_9182",
        sensitivity: "personal",
      },
      { kind: "project.id", role: "resource", value: "prj_441" },
    ],
    attributes: { ownerId: null, operation: "project.import" },
  }),
] satisfies NormalizedEvidence[];

export const fixtureIssueSource: IssueSource = {
  id: "sentry",
  canHandle: (reference) => reference === "fixture:sentry-issue",
  async fetchIssue(
    reference: string,
    _context: ProviderContext,
  ): Promise<NormalizedIssue> {
    const issueEvidenceId = stableId("ev", "sentry:issue-123456");
    const ray = entity(
      "cloudflare.ray_id",
      "correlation",
      "83f1d84d6d7a21ab",
      issueEvidenceId,
    );
    const evidence: NormalizedEvidence = {
      schemaVersion: "1",
      id: issueEvidenceId,
      source: { providerId: "sentry", externalId: "event-789" },
      sourceType: "issue",
      timestamp: occurredAt,
      service: "api",
      level: "error",
      message: "Cannot read properties of undefined (reading 'id')",
      attributes: { environment: "production", release: "api@4f18c28" },
      entities: [ray],
      fingerprint: fingerprint({ reference, occurredAt }),
      redactions: [],
    };
    return {
      schemaVersion: "1",
      source: {
        providerId: "sentry",
        externalId: "123456",
        reference,
      },
      title: "TypeError: Cannot read properties of undefined",
      message: evidence.message,
      occurredAt,
      environment: "production",
      release: "api@4f18c28",
      service: "api",
      stackFrames: [
        {
          filename: "src/projects/update.ts",
          function: "updateProject",
          lineNumber: 42,
          inApp: true,
        },
      ],
      tags: { cloudflare_ray_id: ray.value },
      entities: [ray],
      evidence: [evidence],
    };
  },
};

const inRange = (record: NormalizedEvidence, intent: SearchIntent): boolean =>
  record.timestamp >= intent.timeRange.from && record.timestamp <= intent.timeRange.to;

export const fixtureCloudflareSource: EvidenceSource = {
  id: "cloudflare-workers",
  supports: (intent) =>
    ["cloudflare.ray_id", "request.id", "customer.id", "project.id"].includes(
      intent.entity.kind,
    ),
  async *search(
    intent: SearchIntent,
    context: ProviderContext,
  ): AsyncIterable<NormalizedEvidence> {
    for (const record of fixtureLogs) {
      if (context.signal.aborted) {
        return;
      }
      const matches = record.entities.some(
        (candidate) =>
          candidate.kind === intent.entity.kind &&
          candidate.canonicalValue === intent.entity.value.toLowerCase(),
      );
      if (matches && inRange(record, intent)) {
        yield record;
      }
    }
  },
};
