import { z } from "zod";
import type {
  Entity,
  EvidenceSource,
  NormalizedEvidence,
  ProviderContext,
  SearchIntent,
} from "../contracts.js";
import { fingerprint, stableId } from "../ids.js";

const cloudflareMetadataSchema = z
  .object({
    id: z.string().optional(),
    service: z.string().optional(),
    level: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    outcome: z.string().optional(),
    eventType: z.string().optional(),
  })
  .loose();

const cloudflareEventSchema = z
  .object({
    $metadata: cloudflareMetadataSchema.default({}),
    dataset: z.string().optional(),
    source: z.union([z.string(), z.record(z.string(), z.json())]),
    timestamp: z.number().int().nonnegative(),
  })
  .loose();

const cloudflareQueryResponseSchema = z
  .object({
    success: z.boolean().optional(),
    errors: z.array(z.object({ message: z.string() }).loose()).default([]),
    result: z
      .object({
        events: z
          .object({
            events: z.array(cloudflareEventSchema).default([]),
          })
          .optional(),
      })
      .loose(),
  })
  .loose();

type CloudflareEvent = z.infer<typeof cloudflareEventSchema>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

const entityFields: Record<string, Pick<Entity, "kind" | "role" | "sensitivity">> = {
  cf_ray: {
    kind: "cloudflare.ray_id",
    role: "correlation",
    sensitivity: "none",
  },
  cloudflare_ray_id: {
    kind: "cloudflare.ray_id",
    role: "correlation",
    sensitivity: "none",
  },
  ray_id: {
    kind: "cloudflare.ray_id",
    role: "correlation",
    sensitivity: "none",
  },
  request_id: {
    kind: "request.id",
    role: "correlation",
    sensitivity: "none",
  },
  trace_id: {
    kind: "trace.id",
    role: "correlation",
    sensitivity: "none",
  },
  customer_id: {
    kind: "customer.id",
    role: "subject",
    sensitivity: "personal",
  },
  user_id: {
    kind: "user.id",
    role: "subject",
    sensitivity: "personal",
  },
  project_id: {
    kind: "project.id",
    role: "resource",
    sensitivity: "none",
  },
  job_id: {
    kind: "job.id",
    role: "resource",
    sensitivity: "none",
  },
};

const supportedEntityKinds = new Set(
  Object.values(entityFields).map((definition) => definition.kind),
);

const normalizeFieldName = (value: string): string =>
  value.trim().toLowerCase().replaceAll(".", "_").replaceAll("-", "_");

const primitiveEntries = (input: JsonValue, prefix = ""): Array<[string, string]> => {
  if (
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return [[prefix, String(input)]];
  }
  if (Array.isArray(input)) {
    return input.flatMap((value, index) =>
      primitiveEntries(value, prefix.length === 0 ? `${index}` : `${prefix}.${index}`),
    );
  }
  if (input !== null && typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) =>
      primitiveEntries(value, prefix.length === 0 ? key : `${prefix}.${key}`),
    );
  }
  return [];
};

const extractEntities = (
  source: CloudflareEvent["source"],
  evidenceId: string,
): Entity[] => {
  if (typeof source === "string") return [];
  const candidates = primitiveEntries(source).flatMap(([path, value]) => {
    const field = path.split(".").at(-1) ?? path;
    const definition = entityFields[normalizeFieldName(field)];
    if (definition === undefined || value.length === 0) return [];
    return [
      {
        id: stableId("en", `${definition.kind}:${value.toLowerCase()}`),
        kind: definition.kind,
        role: definition.role,
        value,
        canonicalValue: value.toLowerCase(),
        sensitivity: definition.sensitivity,
        confidence: 1,
        discoveredFromEvidenceId: evidenceId,
        extractorId: "cloudflare.structured-fields",
      } satisfies Entity,
    ];
  });
  return [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.kind}:${candidate.canonicalValue}`,
        candidate,
      ]),
    ).values(),
  ];
};

const messageFor = (event: CloudflareEvent): string | undefined => {
  if (event.$metadata.error !== undefined) return event.$metadata.error;
  if (event.$metadata.message !== undefined) return event.$metadata.message;
  if (typeof event.source === "string") return event.source;
  const message = event.source.message;
  return typeof message === "string" ? message : undefined;
};

const redactMessage = (
  message: string | undefined,
  entities: Entity[],
): { message?: string; redactions: NormalizedEvidence["redactions"] } => {
  if (message === undefined) return { redactions: [] };
  let safeMessage = message;
  const redactions: NormalizedEvidence["redactions"] = [];
  for (const entity of entities) {
    if (entity.sensitivity !== "personal" && entity.sensitivity !== "secret") {
      continue;
    }
    if (!safeMessage.includes(entity.value)) continue;
    safeMessage = safeMessage.replaceAll(entity.value, `[redacted:${entity.kind}]`);
    redactions.push({
      path: "message",
      reason: `${entity.sensitivity} entity`,
    });
  }
  return { message: safeMessage, redactions };
};

const normalizeEvent = (event: CloudflareEvent): NormalizedEvidence => {
  const externalId =
    event.$metadata.id ??
    stableId(
      "cf",
      JSON.stringify({
        timestamp: event.timestamp,
        source: event.source,
        service: event.$metadata.service,
      }),
    );
  const id = stableId("ev", `cloudflare:${externalId}`);
  const entities = extractEntities(event.source, id);
  const safeMessage = redactMessage(messageFor(event), entities);
  const attributes: NormalizedEvidence["attributes"] = {
    ...(event.dataset === undefined ? {} : { dataset: event.dataset }),
    ...(event.$metadata.outcome === undefined
      ? {}
      : { outcome: event.$metadata.outcome }),
    ...(event.$metadata.eventType === undefined
      ? {}
      : { eventType: event.$metadata.eventType }),
  };
  return {
    schemaVersion: "1",
    id,
    source: {
      providerId: "cloudflare-workers",
      externalId,
    },
    sourceType: "log",
    timestamp: new Date(event.timestamp).toISOString(),
    ...(event.$metadata.service === undefined
      ? {}
      : { service: event.$metadata.service }),
    ...(event.$metadata.level === undefined
      ? event.$metadata.error === undefined
        ? {}
        : { level: "error" }
      : { level: event.$metadata.level }),
    ...(safeMessage.message === undefined ? {} : { message: safeMessage.message }),
    attributes,
    entities,
    fingerprint: fingerprint({
      provider: "cloudflare-workers",
      externalId,
      timestamp: event.timestamp,
    }),
    redactions: safeMessage.redactions,
  };
};

export type CloudflareFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareWorkersSourceOptions {
  accountId?: string;
  apiToken?: string;
  baseUrl?: string;
  datasets?: string[];
  fetch?: CloudflareFetch;
}

const queryBody = (intent: SearchIntent, datasets: string[]) => ({
  queryId: intent.id,
  timeframe: {
    from: new Date(intent.timeRange.from).getTime(),
    to: new Date(intent.timeRange.to).getTime(),
  },
  limit: Math.min(intent.limit, 100),
  parameters: {
    datasets,
    filterCombination: "and",
    filters: [],
    needle: {
      value: intent.entity.value,
      isRegex: false,
      matchCase: false,
    },
    limit: Math.min(intent.limit, 100),
    view: "events",
  },
});

export const cloudflareWorkersSource = (
  options: CloudflareWorkersSourceOptions = {},
): EvidenceSource => {
  const baseUrl = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(
    /\/$/,
    "",
  );
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    id: "cloudflare-workers",
    supports: (intent) => supportedEntityKinds.has(intent.entity.kind),
    async *search(intent: SearchIntent, context: ProviderContext) {
      if (options.apiToken === undefined || options.apiToken.length === 0) {
        throw new Error(
          "Cloudflare is not authenticated. Run `tracecause auth login cloudflare` or set CLOUDFLARE_API_TOKEN.",
        );
      }
      if (options.accountId === undefined || options.accountId.length === 0) {
        throw new Error(
          "No Cloudflare account is selected. Run `tracecause auth login cloudflare` or set CLOUDFLARE_ACCOUNT_ID.",
        );
      }
      const response = await fetchImplementation(
        `${baseUrl}/accounts/${encodeURIComponent(options.accountId)}/workers/observability/telemetry/query`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(queryBody(intent, options.datasets ?? [])),
          signal: context.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Cloudflare Workers Observability query failed with HTTP ${response.status}.`,
        );
      }
      const parsed = cloudflareQueryResponseSchema.parse(await response.json());
      if (parsed.success === false || parsed.errors.length > 0) {
        const detail = parsed.errors.map((error) => error.message).join("; ");
        throw new Error(
          `Cloudflare Workers Observability query failed${detail.length === 0 ? "." : `: ${detail}`}`,
        );
      }
      for (const event of parsed.result.events?.events ?? []) {
        if (context.signal.aborted) return;
        yield normalizeEvent(event);
      }
    },
  };
};
