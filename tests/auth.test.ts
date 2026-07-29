import { describe, expect, test } from "bun:test";
import {
  loginSentryDevice,
  resolveCloudflareCredentials,
  type CredentialStore,
  type ProviderCredentials,
  type ProviderName,
} from "../src/auth.js";

const memoryCredentialStore = (): {
  store: CredentialStore;
  saved: Map<ProviderName, ProviderCredentials>;
} => {
  const saved = new Map<ProviderName, ProviderCredentials>();
  return {
    saved,
    store: {
      load: async (provider) => saved.get(provider),
      save: async (provider, credentials) => {
        saved.set(provider, credentials);
      },
      remove: async (provider) => {
        saved.delete(provider);
      },
    },
  };
};

describe("Sentry device authentication", () => {
  test("continues polling when Sentry returns authorization_pending as HTTP 400", async () => {
    const { store, saved } = memoryCredentialStore();
    let tokenRequests = 0;
    const verification: Array<{ url: string; userCode: string }> = [];
    const fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/oauth/device/code/")) {
          return Response.json({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://sentry.example/oauth/device/",
            expires_in: 10,
            interval: 1,
          });
        }
        if (url.endsWith("/oauth/token/")) {
          tokenRequests += 1;
          if (tokenRequests === 1) {
            return Response.json({ error: "authorization_pending" }, { status: 400 });
          }
          return Response.json({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_at: "2026-08-29T00:00:00.000Z",
          });
        }
        if (url.endsWith("/api/0/organizations/")) {
          return Response.json([{ slug: "acme" }]);
        }
        return new Response(null, { status: 404 });
      },
      {
        preconnect: (_url: string | URL): void => {},
      },
    );

    const credentials = await loginSentryDevice({
      clientId: "client-id",
      store,
      fetch,
      baseUrl: "https://sentry.example",
      onVerification: ({ url, userCode }) => {
        verification.push({ url, userCode });
      },
    });

    expect(tokenRequests).toBe(2);
    expect(verification).toEqual([
      {
        url: "https://sentry.example/oauth/device/",
        userCode: "ABCD-EFGH",
      },
    ]);
    expect(credentials).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-08-29T00:00:00.000Z",
      organization: "acme",
    });
    expect(saved.get("sentry")).toEqual(credentials);
  });
});

describe("Cloudflare Wrangler authentication", () => {
  test("reuses Wrangler OAuth and discovers a single account", async () => {
    const { store } = memoryCredentialStore();
    const resolved = await resolveCloudflareCredentials({
      store,
      environment: {},
      readToken: async () => "wrangler-token",
      fetch: Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer wrangler-token",
          );
          return Response.json({
            success: true,
            result: [{ id: "account-123", name: "Acme" }],
          });
        },
        { preconnect: (_url: string | URL): void => {} },
      ),
    });

    expect(resolved).toEqual({
      source: "wrangler",
      credentials: {
        accessToken: "wrangler-token",
        accountId: "account-123",
      },
      missingEnvironmentVariables: [],
    });
  });

  test("requires only account selection when Wrangler exposes multiple accounts", async () => {
    const { store } = memoryCredentialStore();
    const resolved = await resolveCloudflareCredentials({
      store,
      environment: {},
      readToken: async () => "wrangler-token",
      fetch: Object.assign(
        async () =>
          Response.json({
            success: true,
            result: [
              { id: "account-123", name: "Acme" },
              { id: "account-456", name: "Other" },
            ],
          }),
        { preconnect: (_url: string | URL): void => {} },
      ),
    });

    expect(resolved).toEqual({
      source: "partial",
      missingEnvironmentVariables: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });

  test("keeps complete CI environment credentials ahead of Wrangler", async () => {
    const { store } = memoryCredentialStore();
    let readWrangler = false;
    const resolved = await resolveCloudflareCredentials({
      store,
      environment: {
        CLOUDFLARE_API_TOKEN: "ci-token",
        CLOUDFLARE_ACCOUNT_ID: "ci-account",
      },
      readToken: async () => {
        readWrangler = true;
        return "wrangler-token";
      },
    });

    expect(readWrangler).toBe(false);
    expect(resolved.source).toBe("environment");
    expect(resolved.credentials).toEqual({
      accessToken: "ci-token",
      accountId: "ci-account",
    });
  });
});
