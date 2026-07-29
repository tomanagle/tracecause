# Library and architecture

Tracecause is an ESM-only TypeScript package built with tsup. Public contracts
use Promises and async iterables so provider authors do not need to depend on
Effect.

## Public exports

The package root currently exports:

- Authentication stores, resolution, and Sentry device login.
- Zod schemas and inferred contract types.
- Investigation functions and Effect services/layers.
- Knowledge persistence and review operations.
- Sentry, Cloudflare Workers, and CloudWatch provider factories.
- `defineConfig()`.

`defineConfig()` currently provides TypeScript inference only. The CLI does not
load the generated `.tracecause/config.ts`.

## Provider contracts

An issue source supplies:

```ts
interface IssueSource {
  readonly id: string;
  canHandle(reference: string): boolean;
  fetchIssue(reference: string, context: ProviderContext): Promise<NormalizedIssue>;
}
```

An evidence source supplies:

```ts
interface EvidenceSource {
  readonly id: string;
  supports(intent: SearchIntent): boolean;
  search(
    intent: SearchIntent,
    context: ProviderContext,
  ): AsyncIterable<NormalizedEvidence>;
}
```

`ProviderContext` contains a case ID and `AbortSignal`. Providers must pass the
signal to network requests and stop iteration when cancelled.

## Investigation API

```ts
import { investigate } from "tracecause";

const result = await investigate({
  reference,
  issueSource,
  evidenceSources,
  maxQueries: 20,
  maxDepth: 4,
  signal,
});
```

The result contains the validated context and sanitized evidence records.
Optional confirmed knowledge mappings can be supplied with
`knowledgeMappings`.

## Runtime boundary

Internally, Effect v4 beta provides:

- issue and evidence-source services through layers;
- typed issue, evidence, contract, persistence, and knowledge errors;
- interruption propagation to provider `AbortSignal`s;
- scoped case-directory cleanup;
- bounded Sentry device polling;
- concurrent independent filesystem operations.

Zod validates provider responses, public domain objects, persisted knowledge,
and external API boundaries.

## Runtime and tests

- Source and package format: ESM.
- Build target: ES2022.
- Package engine declaration: Node.js 20 or newer.
- Package manager and primary test runner: Bun.
- Formatting and linting: Oxfmt and Oxlint.
- Build: tsup.

Run the complete local verification:

```bash
bun run check
```

This checks formatting, linting, TypeScript, Bun tests, and both library and CLI
bundles.
