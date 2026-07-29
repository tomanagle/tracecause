import { z } from "zod";
import type {
  Entity,
  IssueSource,
  NormalizedEvidence,
  NormalizedIssue,
} from "../contracts.js";
import { fingerprint, stableId } from "../ids.js";

const sentryIssueResponseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    level: z.string().optional(),
    firstSeen: z.iso.datetime().optional(),
    lastSeen: z.iso.datetime().optional(),
    project: z
      .object({
        id: z.string(),
        slug: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const sentryFrameSchema = z
  .object({
    filename: z.string().nullish(),
    absPath: z.string().nullish(),
    function: z.string().nullish(),
    lineNo: z.number().int().positive().nullish(),
    inApp: z.boolean().nullish(),
  })
  .passthrough();

const sentryEventResponseSchema = z
  .object({
    id: z.string(),
    eventID: z.string().optional(),
    title: z.string(),
    message: z.string().optional(),
    dateCreated: z.iso.datetime(),
    platform: z.string().optional(),
    projectID: z.string().optional(),
    tags: z
      .array(
        z
          .object({
            key: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
          })
          .passthrough(),
      )
      .default([]),
    contexts: z.record(z.string(), z.json()).optional(),
    release: z
      .union([
        z.string(),
        z
          .object({
            version: z.string(),
          })
          .passthrough(),
      ])
      .nullish(),
    entries: z
      .array(
        z
          .object({
            type: z.string(),
            data: z.unknown(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const exceptionDataSchema = z
  .object({
    values: z.array(
      z
        .object({
          type: z.string().nullish(),
          value: z.string().nullish(),
          stacktrace: z
            .object({
              frames: z.array(sentryFrameSchema).default([]),
            })
            .nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const requestDataSchema = z
  .object({
    url: z.string().nullish(),
    method: z.string().nullish(),
    headers: z.array(z.tuple([z.string(), z.string()])).optional(),
  })
  .passthrough();

type SentryEvent = z.infer<typeof sentryEventResponseSchema>;
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

const normalizeFieldName = (value: string): string =>
  value.trim().toLowerCase().replaceAll(".", "_").replaceAll("-", "_");

const makeEntity = (
  field: string,
  value: string,
  evidenceId: string,
): Entity | undefined => {
  const definition = entityFields[normalizeFieldName(field)];
  if (definition === undefined || value.length === 0) return undefined;
  return {
    id: stableId("en", `${definition.kind}:${value.toLowerCase()}`),
    kind: definition.kind,
    role: definition.role,
    value,
    canonicalValue: value.toLowerCase(),
    sensitivity: definition.sensitivity,
    confidence: 1,
    discoveredFromEvidenceId: evidenceId,
    extractorId: "sentry.known-fields",
  };
};

const contextEntries = (input: JsonValue, prefix = ""): Array<[string, string]> => {
  if (typeof input === "string") return [[prefix, input]];
  if (Array.isArray(input)) {
    return input.flatMap((value, index) =>
      contextEntries(value, prefix.length === 0 ? `${index}` : `${prefix}.${index}`),
    );
  }
  if (input !== null && typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) =>
      contextEntries(value, prefix.length === 0 ? key : `${prefix}.${key}`),
    );
  }
  return [];
};

const extractEntities = (event: SentryEvent, evidenceId: string): Entity[] => {
  const candidates: Entity[] = [];
  for (const tag of event.tags) {
    const found = makeEntity(tag.key, String(tag.value), evidenceId);
    if (found !== undefined) candidates.push(found);
  }
  for (const entry of event.entries) {
    if (entry.type !== "request") continue;
    const parsed = requestDataSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    for (const [header, value] of parsed.data.headers ?? []) {
      const found = makeEntity(header, value, evidenceId);
      if (found !== undefined) candidates.push(found);
    }
  }
  for (const [path, value] of Object.entries(event.contexts ?? {}).flatMap(
    ([key, context]) => contextEntries(context, key),
  )) {
    const field = path.split(".").at(-1) ?? path;
    const found = makeEntity(field, value, evidenceId);
    if (found !== undefined) candidates.push(found);
  }
  return [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.kind}:${candidate.canonicalValue}`,
        candidate,
      ]),
    ).values(),
  ];
};

const extractStackFrames = (event: SentryEvent): NormalizedIssue["stackFrames"] => {
  const frames: NormalizedIssue["stackFrames"] = [];
  for (const entry of event.entries) {
    if (entry.type !== "exception") continue;
    const parsed = exceptionDataSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    for (const exception of parsed.data.values) {
      for (const frame of exception.stacktrace?.frames ?? []) {
        const filename = frame.filename ?? frame.absPath;
        if (filename === null || filename === undefined) continue;
        frames.push({
          filename,
          ...(frame.function == null ? {} : { function: frame.function }),
          ...(frame.lineNo == null ? {} : { lineNumber: frame.lineNo }),
          ...(frame.inApp == null ? {} : { inApp: frame.inApp }),
        });
      }
    }
  }
  return frames;
};

const extractMessage = (event: SentryEvent): string | undefined => {
  for (const entry of event.entries) {
    if (entry.type !== "exception") continue;
    const parsed = exceptionDataSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    const exception = parsed.data.values.at(-1);
    if (exception?.value != null) {
      return exception.type == null
        ? exception.value
        : `${exception.type}: ${exception.value}`;
    }
  }
  return event.message === undefined || event.message.length === 0
    ? undefined
    : event.message;
};

const extractRequestAttributes = (
  event: SentryEvent,
): NormalizedEvidence["attributes"] => {
  const requestEntry = event.entries.find((entry) => entry.type === "request");
  if (requestEntry === undefined) return {};
  const parsed = requestDataSchema.safeParse(requestEntry.data);
  if (!parsed.success) return {};
  return {
    ...(parsed.data.url == null ? {} : { requestUrl: parsed.data.url }),
    ...(parsed.data.method == null ? {} : { requestMethod: parsed.data.method }),
  };
};

export type SentryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SentryIssueSourceOptions {
  organization?: string;
  authToken?: string;
  baseUrl?: string;
  fetch?: SentryFetch;
}

interface SentryReference {
  organization: string;
  issueId: string;
}

export const parseSentryReference = (
  reference: string,
  configuredOrganization?: string,
): SentryReference | undefined => {
  if (/^\d+$/.test(reference)) {
    return configuredOrganization === undefined
      ? undefined
      : { organization: configuredOrganization, issueId: reference };
  }
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const issueIndex = segments.indexOf("issues");
  const issueId = segments[issueIndex + 1];
  if (issueIndex < 0 || issueId === undefined) return undefined;
  const organizationIndex = segments.indexOf("organizations");
  const organization =
    organizationIndex >= 0
      ? segments[organizationIndex + 1]
      : (configuredOrganization ?? url.hostname.split(".")[0]);
  if (organization === undefined || organization === "sentry") return undefined;
  return { organization, issueId };
};

const fetchJson = async (
  fetchImplementation: SentryFetch,
  url: string,
  authToken: string,
  signal: AbortSignal,
): Promise<unknown> => {
  const response = await fetchImplementation(url, {
    headers: { authorization: `Bearer ${authToken}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Sentry API request failed with HTTP ${response.status}.`);
  }
  return response.json();
};

export const sentryIssueSource = (
  options: SentryIssueSourceOptions = {},
): IssueSource => {
  const baseUrl = (options.baseUrl ?? "https://sentry.io").replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    id: "sentry",
    canHandle: (reference) =>
      parseSentryReference(reference, options.organization) !== undefined,
    async fetchIssue(reference, context) {
      const parsedReference = parseSentryReference(reference, options.organization);
      if (parsedReference === undefined) {
        throw new Error("Unsupported Sentry issue reference.");
      }
      if (options.authToken === undefined || options.authToken.length === 0) {
        throw new Error(
          "Sentry is not authenticated. Run `rootcause auth login sentry` or set SENTRY_AUTH_TOKEN.",
        );
      }
      const issueUrl = `${baseUrl}/api/0/organizations/${encodeURIComponent(parsedReference.organization)}/issues/${encodeURIComponent(parsedReference.issueId)}/`;
      const eventUrl = `${issueUrl}events/recommended/`;
      const issueInput = await fetchJson(
        fetchImplementation,
        issueUrl,
        options.authToken,
        context.signal,
      );
      const eventInput = await fetchJson(
        fetchImplementation,
        eventUrl,
        options.authToken,
        context.signal,
      );
      const issue = sentryIssueResponseSchema.parse(issueInput);
      const event = sentryEventResponseSchema.parse(eventInput);
      const evidenceId = stableId("ev", `sentry:${event.eventID ?? event.id}`);
      const entities = extractEntities(event, evidenceId);
      const tags = Object.fromEntries(event.tags.map((tag) => [tag.key, tag.value]));
      const message = extractMessage(event);
      const release =
        typeof event.release === "string"
          ? event.release
          : (event.release?.version ?? undefined);
      const evidence: NormalizedEvidence = {
        schemaVersion: "1",
        id: evidenceId,
        source: {
          providerId: "sentry",
          externalId: event.eventID ?? event.id,
        },
        sourceType: "issue",
        timestamp: new Date(event.dateCreated).toISOString(),
        ...(issue.level === undefined ? {} : { level: issue.level }),
        ...(message === undefined ? {} : { message }),
        attributes: {
          projectId: issue.project.id,
          projectSlug: issue.project.slug,
          organization: parsedReference.organization,
          ...extractRequestAttributes(event),
        },
        entities,
        fingerprint: fingerprint({
          provider: "sentry",
          eventId: event.eventID ?? event.id,
        }),
        redactions: [],
      };
      return {
        schemaVersion: "1",
        source: {
          providerId: "sentry",
          externalId: issue.id,
          reference,
        },
        title: issue.title || event.title,
        ...(message === undefined ? {} : { message }),
        occurredAt: evidence.timestamp,
        ...(issue.firstSeen === undefined ? {} : { firstSeenAt: issue.firstSeen }),
        ...(issue.lastSeen === undefined ? {} : { lastSeenAt: issue.lastSeen }),
        ...(typeof tags.environment !== "string"
          ? {}
          : { environment: tags.environment }),
        ...(release === undefined ? {} : { release }),
        service: issue.project.slug,
        stackFrames: extractStackFrames(event),
        tags,
        entities,
        evidence: [evidence],
      };
    },
  };
};
