# CLI reference

## `tracecause init`

Creates the `.tracecause` repository directory described in
[Getting started](./getting-started.md). Existing files are not overwritten.

## `tracecause investigate <reference>`

Accepts:

- A Sentry URL using either the organization path or organization subdomain.
- A numeric Sentry issue ID when the active Sentry credentials identify an
  organization.
- `fixture:sentry-issue` for the deterministic built-in fixture.

Options:

| Option          | Default           | Behavior                                                                                                                          |
| --------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--format`      | `terminal`        | `json` emits JSON when output is stdout; other values emit agent Markdown on stdout. Persisted cases always include both formats. |
| `--output`      | Current directory | Root under which `.tracecause/cases/` is written, or `stdout`.                                                                    |
| `--max-queries` | `20`              | Maximum evidence-provider searches.                                                                                               |
| `--max-depth`   | `4`               | Maximum recursive entity-pivot depth.                                                                                             |

Example:

```bash
npx tracecause investigate \
  "https://posty.sentry.io/issues/7392124237/" \
  --max-queries 10 \
  --max-depth 3
```

## Authentication commands

```bash
tracecause auth login sentry
tracecause auth login cloudflare
tracecause auth status sentry
tracecause auth status cloudflare
tracecause auth logout sentry
tracecause auth logout cloudflare
```

`auth login cloudflare` currently prints the Wrangler login instruction rather
than running a Tracecause-managed OAuth flow. `auth logout cloudflare` removes
credentials stored by Tracecause; it does not log Wrangler out.

See [Authentication](./authentication.md) for credential precedence and CI
configuration.

## Knowledge commands

### `tracecause knowledge show`

Prints reviewed mappings and unreviewed local observations as JSON.

### `tracecause knowledge validate`

Parses and validates both knowledge documents, then reports their mapping
counts. Invalid schemas fail the command.

### `tracecause knowledge promote`

Promotes all current local observations to confirmed mappings in
`.tracecause/knowledge.yaml`, then clears the local observation list. Review
`knowledge show` before running it.

### `tracecause knowledge forget <mapping-id>`

Removes a mapping with the given ID from both reviewed knowledge and local
observations.

## Not implemented

The current CLI does not include `config validate`, case listing/show commands,
verbose/quiet modes, wall-time or byte budgets, repository controls, or
selective promotion of one observation.
