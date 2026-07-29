# Tracecause documentation

These documents describe the functionality implemented in the current
Tracecause package.

## User guides

- [Getting started](./getting-started.md) — install, initialize, investigate,
  and consume a case.
- [CLI reference](./cli.md) — every implemented command, argument, and option.
- [Authentication](./authentication.md) — Sentry, Cloudflare, AWS, local
  storage, environment precedence, and CI.
- [Evidence providers](./providers.md) — Sentry ingestion, Cloudflare Workers
  logs, CloudWatch Logs Insights, entity extraction, and query behavior.
- [Cases and knowledge](./cases-and-knowledge.md) — persisted files, redaction,
  observations, promotion, and reuse.
- [Library and architecture](./library-and-architecture.md) — public exports,
  provider contracts, Effect boundaries, schemas, and runtime support.
- [Releasing](./releasing.md) — Release Please and npm trusted publishing.

## Current boundary

Tracecause gathers and organizes evidence. It does not currently inspect the
repository, generate a root-cause explanation with a model, propose a code fix,
load `.tracecause/config.ts`, enforce `.tracecause/policies.yaml`, refresh
stored Sentry access tokens, or narrow provider queries using confirmed service
mappings. Confirmed knowledge currently influences provider ranking only.
