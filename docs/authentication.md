# Authentication

Tracecause keeps provider authentication outside repository files and never
prints access tokens.

## Credential precedence

Complete environment credentials take precedence over local credentials. This
makes CI deterministic and prevents interactive authentication in automation.
Partially configured environment credentials are reported as incomplete.

## Sentry

For local use:

```bash
npx tracecause auth login sentry
npx tracecause auth status sentry
```

Tracecause starts Sentry's OAuth device flow, prints the verification URL and
code, polls until authorization completes, discovers the first accessible
organization, and stores the result in:

```text
${XDG_CONFIG_HOME:-~/.config}/tracecause/credentials.json
```

The directory and file are created with user-only permissions. Override the
location with `TRACECAUSE_CONFIG_HOME`. The legacy
`ROOTCAUSE_CONFIG_HOME` variable is also recognized.

For CI:

```bash
export SENTRY_AUTH_TOKEN="..."
export SENTRY_ORG="<organization-slug>"
```

Both variables must be set together. Stored refresh tokens are retained, but
automatic Sentry access-token refresh is not implemented yet.

## Cloudflare

For local use, authenticate with Cloudflare's Wrangler CLI:

```bash
npx wrangler login --use-keyring
npx tracecause auth status cloudflare
```

Tracecause runs `wrangler auth token --json`, uses the returned OAuth token only
in memory, and leaves storage and refresh to Wrangler. It does not read
Wrangler's credential files.

If the session exposes exactly one account, Tracecause discovers it
automatically. For multiple accounts, select the non-secret account ID:

```bash
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
```

Wrangler must be available on the command's `PATH`.

For CI:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
```

Both variables must be set together. The token needs access to the selected
account's Workers Observability telemetry.

`tracecause auth login cloudflare` currently directs the user to Wrangler.
`tracecause auth logout cloudflare` does not revoke or remove Wrangler's OAuth
session; use Wrangler for that lifecycle.

## AWS CloudWatch

Tracecause uses the standard AWS SDK credential chain. Local AWS CLI profiles,
IAM Identity Center sessions, environment credentials, web identity, ECS task
credentials, and EC2 instance credentials are supported by that chain.

Example:

```bash
aws configure sso --profile my-company
aws sso login --profile my-company

export AWS_PROFILE="my-company"
export AWS_REGION="ap-southeast-2"
export TRACECAUSE_AWS_LOG_GROUPS="/aws/lambda/api,/aws/lambda/jobs"
```

`AWS_DEFAULT_REGION` is used when `AWS_REGION` is absent. The provider defaults
to `us-east-1` if neither is configured. Log groups are a required,
comma-separated allowlist.

The AWS identity needs:

```text
logs:StartQuery
logs:GetQueryResults
```

Tracecause signs API requests with Signature Version 4 and does not persist AWS
credentials.
