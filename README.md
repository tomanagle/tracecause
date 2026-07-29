# Tracecause

Tracecause follows identifiers and evidence across production systems to build
the context needed to investigate a production bug.

The project is in early development. The first runnable slice uses deterministic
Sentry and Cloudflare fixtures:

```bash
bun install
bun run src/cli.ts investigate fixture:sentry-issue
```

Live Sentry-to-Cloudflare investigations currently use environment credentials:

```bash
export SENTRY_AUTH_TOKEN="..."
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."

bun run src/cli.ts investigate \
  "https://sentry.io/organizations/example/issues/123456/"
```

Interactive OAuth login is planned but is not implemented yet.
