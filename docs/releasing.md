# Releasing Tracecause

Tracecause uses Release Please for versioning, changelog updates, GitHub releases,
and release tags. npm publishing uses trusted publishing through GitHub's OIDC
identity; the repository does not need an `NPM_TOKEN`.

## One-time npm setup

The package owner must configure the `tracecause` package on npm:

1. Open the package's trusted publisher settings.
2. Select GitHub Actions.
3. Set the repository owner to `tomanagle`.
4. Set the repository name to `tracecause`.
5. Set the workflow filename to `release.yml`.
6. Allow `npm publish`.

The initial publication requires a one-time bootstrap because npm cannot attach
a trusted publisher to a package that does not exist yet:

1. Create a short-lived granular npm access token with permission to create a
   public `tracecause` package and publishing bypass enabled.
2. Add it to the GitHub repository as the `NPM_TOKEN` Actions secret.
3. Merge the next Release Please pull request. The release workflow uses the
   token to create the package.
4. Configure trusted publishing using the settings above.
5. Delete the `NPM_TOKEN` repository secret.

After the secret is deleted, npm automatically uses the workflow's OIDC
identity for subsequent releases.

## Normal release flow

1. Merge changes to `main` using Conventional Commit titles such as `feat:`,
   `fix:`, or `docs:`.
2. Release Please creates or updates a release pull request containing the
   package version and `CHANGELOG.md`.
3. Review and merge the release pull request.
4. The release workflow verifies the project, creates the GitHub release and
   `vX.Y.Z` tag, checks the package contents, and publishes to npm.

The workflow requires GitHub-hosted runners and the `id-token: write`
permission. It deliberately uses the same workflow for tag creation and npm
publishing because events created with the default `GITHUB_TOKEN` do not start
additional workflow runs.
