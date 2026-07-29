import { describe, expect, test } from "bun:test";
import {
  loginSentryDevice,
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
