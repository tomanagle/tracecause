import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Data, Effect, Schedule } from "effect";
import { z } from "zod";

const providerCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.iso.datetime().optional(),
  organization: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
});

const credentialDocumentSchema = z.object({
  schemaVersion: z.literal("1"),
  sentry: providerCredentialsSchema.optional(),
  cloudflare: providerCredentialsSchema.optional(),
});

export type ProviderName = "sentry" | "cloudflare";
export type ProviderCredentials = z.infer<typeof providerCredentialsSchema>;
type CredentialDocument = z.infer<typeof credentialDocumentSchema>;

export interface CredentialStore {
  load(provider: ProviderName): Promise<ProviderCredentials | undefined>;
  save(provider: ProviderName, credentials: ProviderCredentials): Promise<void>;
  remove(provider: ProviderName): Promise<void>;
}

export class CredentialStoreError extends Data.TaggedError("CredentialStoreError")<{
  readonly operation: "load" | "save" | "remove";
  readonly provider: ProviderName;
  readonly cause: unknown;
}> {}

export class AuthenticationError extends Data.TaggedError("AuthenticationError")<{
  readonly provider: ProviderName;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const defaultCredentialPath = (): string => {
  const configured = process.env.ROOTCAUSE_CONFIG_HOME;
  const root =
    configured ??
    (process.env.XDG_CONFIG_HOME === undefined
      ? join(homedir(), ".config")
      : process.env.XDG_CONFIG_HOME);
  return join(root, "tracecause", "credentials.json");
};

export const fileCredentialStore = (
  path = defaultCredentialPath(),
): CredentialStore => {
  const read = async (): Promise<CredentialDocument> => {
    try {
      return credentialDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        return { schemaVersion: "1" };
      }
      throw cause;
    }
  };
  const write = async (document: CredentialDocument): Promise<void> => {
    const temporaryPath = `${path}.tmp-${process.pid}`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  };
  return {
    load: async (provider) => (await read())[provider],
    save: async (provider, credentials) => {
      const document = await read();
      await write({ ...document, [provider]: credentials });
    },
    remove: async (provider) => {
      const document = await read();
      const next: CredentialDocument =
        provider === "sentry"
          ? {
              schemaVersion: "1",
              ...(document.cloudflare === undefined
                ? {}
                : { cloudflare: document.cloudflare }),
            }
          : {
              schemaVersion: "1",
              ...(document.sentry === undefined ? {} : { sentry: document.sentry }),
            };
      await write(next);
    },
  };
};

export type CredentialSource = "environment" | "stored" | "missing" | "partial";

export interface ResolvedCredentials {
  source: CredentialSource;
  credentials?: ProviderCredentials;
  missingEnvironmentVariables: string[];
}

export const resolveCredentials = async (
  provider: ProviderName,
  store: CredentialStore,
  environment: Record<string, string | undefined> = process.env,
): Promise<ResolvedCredentials> => {
  const tokenName =
    provider === "sentry" ? "SENTRY_AUTH_TOKEN" : "CLOUDFLARE_API_TOKEN";
  const scopeName = provider === "sentry" ? "SENTRY_ORG" : "CLOUDFLARE_ACCOUNT_ID";
  const token = environment[tokenName];
  const scope = environment[scopeName];
  if (token !== undefined || scope !== undefined) {
    const missing = [
      ...(token === undefined ? [tokenName] : []),
      ...(scope === undefined ? [scopeName] : []),
    ];
    if (missing.length > 0) {
      return { source: "partial", missingEnvironmentVariables: missing };
    }
    return {
      source: "environment",
      credentials: {
        accessToken: token ?? "",
        ...(provider === "sentry"
          ? { organization: scope ?? "" }
          : { accountId: scope ?? "" }),
      },
      missingEnvironmentVariables: [],
    };
  }
  const stored = await store.load(provider);
  return stored === undefined
    ? { source: "missing", missingEnvironmentVariables: [tokenName, scopeName] }
    : {
        source: "stored",
        credentials: stored,
        missingEnvironmentVariables: [],
      };
};

const sentryDeviceCodeSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});

const sentryTokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_at: z.iso.datetime().optional(),
});

const sentryTokenErrorSchema = z.object({
  error: z.enum([
    "authorization_pending",
    "slow_down",
    "access_denied",
    "expired_token",
  ]),
});

class AuthorizationPending extends Data.TaggedError("AuthorizationPending")<{}> {}

export interface SentryDeviceLoginOptions {
  clientId: string;
  store: CredentialStore;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  onVerification: (input: { url: string; userCode: string; expiresIn: number }) => void;
}

const postForm = (
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  fields: Record<string, string>,
) =>
  Effect.tryPromise({
    try: () =>
      fetchImplementation(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      }),
    catch: (cause) =>
      new AuthenticationError({
        provider: "sentry",
        message: "Sentry OAuth request failed.",
        cause,
      }),
  });

export const loginSentryDeviceEffect = Effect.fn("Auth.loginSentryDevice")(function* (
  options: SentryDeviceLoginOptions,
) {
  const baseUrl = (options.baseUrl ?? "https://sentry.io").replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const deviceInput = yield* postForm(
    fetchImplementation,
    `${baseUrl}/oauth/device/code/`,
    {
      client_id: options.clientId,
      scope: "org:read project:read event:read",
    },
  );
  const deviceResult = sentryDeviceCodeSchema.safeParse(deviceInput);
  if (!deviceResult.success) {
    return yield* Effect.fail(
      new AuthenticationError({
        provider: "sentry",
        message: "Sentry returned an invalid device authorization response.",
        cause: deviceResult.error,
      }),
    );
  }
  const device = deviceResult.data;
  yield* Effect.sync(() =>
    options.onVerification({
      url: device.verification_uri_complete ?? device.verification_uri,
      userCode: device.user_code,
      expiresIn: device.expires_in,
    }),
  );

  const poll = Effect.gen(function* () {
    const tokenInput = yield* postForm(fetchImplementation, `${baseUrl}/oauth/token/`, {
      client_id: options.clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const token = sentryTokenSchema.safeParse(tokenInput);
    if (token.success) return token.data;
    const error = sentryTokenErrorSchema.safeParse(tokenInput);
    if (
      error.success &&
      (error.data.error === "authorization_pending" || error.data.error === "slow_down")
    ) {
      return yield* Effect.fail(new AuthorizationPending());
    }
    return yield* Effect.fail(
      new AuthenticationError({
        provider: "sentry",
        message: error.success
          ? `Sentry authorization failed: ${error.data.error}.`
          : "Sentry returned an invalid token response.",
        ...(!error.success ? { cause: error.error } : {}),
      }),
    );
  });
  const attempts = Math.max(1, Math.ceil(device.expires_in / device.interval));
  const token = yield* poll.pipe(
    Effect.retry({
      schedule: Schedule.spaced(`${device.interval} seconds`),
      times: attempts,
      while: (error) => error instanceof AuthorizationPending,
    }),
    Effect.catchTag("AuthorizationPending", () =>
      Effect.fail(
        new AuthenticationError({
          provider: "sentry",
          message: "Sentry authorization expired before it was completed.",
        }),
      ),
    ),
  );
  const organizationsInput = yield* Effect.tryPromise({
    try: () =>
      fetchImplementation(`${baseUrl}/api/0/organizations/`, {
        headers: { authorization: `Bearer ${token.access_token}` },
      }).then((response) => response.json()),
    catch: (cause) =>
      new AuthenticationError({
        provider: "sentry",
        message: "Could not discover the authorized Sentry organization.",
        cause,
      }),
  });
  const organizations = z
    .array(z.looseObject({ slug: z.string() }))
    .safeParse(organizationsInput);
  const organization = organizations.success
    ? organizations.data.at(0)?.slug
    : undefined;
  if (organization === undefined) {
    return yield* Effect.fail(
      new AuthenticationError({
        provider: "sentry",
        message: "The OAuth session does not expose an accessible organization.",
      }),
    );
  }
  const credentials: ProviderCredentials = {
    accessToken: token.access_token,
    ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
    ...(token.expires_at === undefined ? {} : { expiresAt: token.expires_at }),
    organization,
  };
  yield* Effect.tryPromise({
    try: () => options.store.save("sentry", credentials),
    catch: (cause) =>
      new CredentialStoreError({
        operation: "save",
        provider: "sentry",
        cause,
      }),
  });
  return credentials;
});

export const loginSentryDevice = (
  options: SentryDeviceLoginOptions,
): Promise<ProviderCredentials> => Effect.runPromise(loginSentryDeviceEffect(options));
