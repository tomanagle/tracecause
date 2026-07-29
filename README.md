# Rootcause

Rootcause follows identifiers and evidence across production systems to build
the context needed to investigate a production bug.

The project is in early development. The first runnable slice uses deterministic
Sentry and Cloudflare fixtures:

```bash
bun install
bun run src/cli.ts investigate fixture:sentry-issue
```

# rootcause
