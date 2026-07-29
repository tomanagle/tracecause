import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { z } from "zod";
import type {
  Entity,
  EvidenceSource,
  NormalizedEvidence,
  ProviderContext,
  SearchIntent,
} from "../contracts.js";
import { fingerprint, stableId } from "../ids.js";

const queryFieldSchema = z
  .object({
    field: z.string(),
    value: z.string(),
  })
  .strict();

const startQueryResponseSchema = z
  .object({
    queryId: z.string(),
  })
  .strict();

const queryResultsResponseSchema = z
  .object({
    status: z.enum([
      "Scheduled",
      "Running",
      "Complete",
      "Failed",
      "Cancelled",
      "Timeout",
      "Unknown",
    ]),
    results: z.array(z.array(queryFieldSchema)).default([]),
  })
  .loose();

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
  cron_id: {
    kind: "cron.id",
    role: "resource",
    sensitivity: "none",
  },
};

const supportedEntityKinds = new Set([
  ...Object.values(entityFields).map((definition) => definition.kind),
  "service.name",
]);

const normalizeFieldName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll(".", "_")
    .replaceAll("-", "_");

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

const decodeMessage = (message: string): JsonValue | undefined => {
  try {
    const parsed: unknown = JSON.parse(message);
    const result = z.json().safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const extractEntities = (
  fields: ReadonlyMap<string, string>,
  message: JsonValue | undefined,
  evidenceId: string,
): Entity[] => {
  const entries = [
    ...fields.entries(),
    ...(message === undefined ? [] : primitiveEntries(message)),
  ];
  const candidates = entries.flatMap(([path, value]) => {
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
        extractorId: "cloudwatch.structured-fields",
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

const redactMessage = (
  message: string,
  entities: Entity[],
): Pick<NormalizedEvidence, "message" | "redactions"> => {
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

const timestampFor = (fields: ReadonlyMap<string, string>): string => {
  const timestamp = fields.get("@timestamp");
  if (timestamp === undefined) return new Date(0).toISOString();
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime())
    ? new Date(0).toISOString()
    : parsed.toISOString();
};

const normalizeResult = (
  row: z.infer<typeof queryFieldSchema>[],
  logGroupNames: string[],
): NormalizedEvidence => {
  const fields = new Map(row.map(({ field, value }) => [field, value]));
  const message = fields.get("@message") ?? "";
  const decodedMessage = decodeMessage(message);
  const externalId =
    fields.get("@ptr") ??
    stableId(
      "aws",
      JSON.stringify({
        timestamp: fields.get("@timestamp"),
        message,
        logStream: fields.get("@logStream"),
      }),
    );
  const id = stableId("ev", `cloudwatch:${externalId}`);
  const entities = extractEntities(fields, decodedMessage, id);
  const safeMessage = redactMessage(message, entities);
  const service =
    fields.get("service") ??
    fields.get("service.name") ??
    fields.get("@log") ??
    fields.get("@logStream");
  const level = fields.get("level") ?? fields.get("severity");
  const logStream = fields.get("@logStream");
  return {
    schemaVersion: "1",
    id,
    source: {
      providerId: "aws-cloudwatch",
      externalId,
    },
    sourceType: "log",
    timestamp: timestampFor(fields),
    ...(service === undefined ? {} : { service }),
    ...(level === undefined ? {} : { level }),
    ...(message.length === 0 ? {} : { message: safeMessage.message }),
    attributes: {
      logGroups: logGroupNames,
      ...(logStream === undefined ? {} : { logStream }),
    },
    entities,
    fingerprint: fingerprint({
      provider: "aws-cloudwatch",
      externalId,
      timestamp: timestampFor(fields),
    }),
    redactions: safeMessage.redactions,
  };
};

const encoder = new TextEncoder();

const toHex = (input: ArrayBuffer): string =>
  [...new Uint8Array(input)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const sha256 = async (value: string): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const hmac = async (key: ArrayBuffer, value: string): Promise<ArrayBuffer> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
};

const awsEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .toSorted(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join("&");

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type AwsCredentialsProvider = () => Promise<AwsCredentials>;

interface SignedRequest {
  url: string;
  init: RequestInit;
}

const signRequest = async ({
  body,
  credentials,
  now,
  region,
  target,
  url,
}: {
  body: string;
  credentials: AwsCredentials;
  now: Date;
  region: string;
  target: string;
  url: URL;
}): Promise<SignedRequest> => {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers = new Headers({
    "content-type": "application/x-amz-json-1.1",
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-target": target,
  });
  if (credentials.sessionToken !== undefined) {
    headers.set("x-amz-security-token", credentials.sessionToken);
  }
  const signedHeaderNames = [...headers.keys()].toSorted();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers.get(name)?.trim() ?? ""}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    url.pathname,
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    await sha256(body),
  ].join("\n");
  const scope = `${date}/${region}/logs/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(canonicalRequest),
  ].join("\n");
  const dateKey = await hmac(
    Uint8Array.from(encoder.encode(`AWS4${credentials.secretAccessKey}`)).buffer,
    date,
  );
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "logs");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = toHex(await hmac(signingKey, stringToSign));
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return {
    url: url.toString(),
    init: {
      method: "POST",
      headers,
      body,
    },
  };
};

export type CloudWatchFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudWatchLogsSourceOptions {
  region?: string;
  logGroupNames: string[];
  credentials?: AwsCredentials;
  credentialProvider?: AwsCredentialsProvider;
  endpoint?: string;
  pollIntervalMs?: number;
  fetch?: CloudWatchFetch;
  now?: () => Date;
}

const escapePattern = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("/", "\\/");

export const cloudWatchLogsInsightsQuery = (intent: SearchIntent): string =>
  [
    "fields @timestamp, @message, @logStream, @log",
    `| filter @message like /${escapePattern(intent.entity.value)}/`,
    "| sort @timestamp asc",
    `| limit ${Math.min(intent.limit, 10_000)}`,
  ].join("\n");

const wait = (duration: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, duration);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export const cloudWatchLogsSource = (
  options: CloudWatchLogsSourceOptions,
): EvidenceSource => {
  const region = options.region ?? "us-east-1";
  const endpoint =
    options.endpoint?.replace(/\/$/, "") ?? `https://logs.${region}.amazonaws.com`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const explicitCredentials = options.credentials;
  const credentialProvider =
    explicitCredentials === undefined
      ? (options.credentialProvider ?? defaultProvider())
      : async () => explicitCredentials;

  const request = async (
    target: "Logs_20140328.StartQuery" | "Logs_20140328.GetQueryResults",
    body: string,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (options.logGroupNames.length === 0) {
      throw new Error(
        "No CloudWatch log groups are configured. Set TRACECAUSE_AWS_LOG_GROUPS.",
      );
    }
    const credentials = await credentialProvider().catch((cause: unknown) => {
      throw new Error(
        "AWS credentials could not be resolved. Run `aws sso login --profile <profile>` or configure the standard AWS credential chain.",
        { cause },
      );
    });
    const signed = await signRequest({
      body,
      credentials,
      now: now(),
      region,
      target,
      url: new URL(endpoint),
    });
    const response = await fetchImplementation(signed.url, {
      ...signed.init,
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `CloudWatch Logs Insights request failed with HTTP ${response.status}.`,
      );
    }
    return response.json();
  };

  return {
    id: "aws-cloudwatch",
    supports: (intent) => supportedEntityKinds.has(intent.entity.kind),
    async *search(intent: SearchIntent, context: ProviderContext) {
      const startResponse = startQueryResponseSchema.parse(
        await request(
          "Logs_20140328.StartQuery",
          JSON.stringify({
            logGroupNames: options.logGroupNames,
            startTime: Math.floor(new Date(intent.timeRange.from).getTime() / 1000),
            endTime: Math.ceil(new Date(intent.timeRange.to).getTime() / 1000),
            queryString: cloudWatchLogsInsightsQuery(intent),
            limit: Math.min(intent.limit, 10_000),
          }),
          context.signal,
        ),
      );

      const getCompletedResults = async (): Promise<
        z.infer<typeof queryResultsResponseSchema>
      > => {
        const result = queryResultsResponseSchema.parse(
          await request(
            "Logs_20140328.GetQueryResults",
            JSON.stringify({ queryId: startResponse.queryId }),
            context.signal,
          ),
        );
        if (result.status === "Complete") {
          return result;
        }
        if (
          result.status === "Failed" ||
          result.status === "Cancelled" ||
          result.status === "Timeout" ||
          result.status === "Unknown"
        ) {
          throw new Error(
            `CloudWatch Logs Insights query ended with ${result.status}.`,
          );
        }
        await wait(options.pollIntervalMs ?? 500, context.signal);
        return getCompletedResults();
      };

      const result = await getCompletedResults();
      for (const row of result.results) {
        yield normalizeResult(row, options.logGroupNames);
      }
    },
  };
};
