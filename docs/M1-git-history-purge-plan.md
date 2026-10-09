# M1 Git history purge plan (approval required)

**Status: prepared only. Do not run these commands until the repository owner approves.**

## Scope

The configured Git remote is `origin` (fetch and push URLs are configured). The local branch is currently unpushed by the available tracking status, but the repository has a remote, so treat historical secrets and browser sessions as exposed if the branch or any ancestor was ever shared. Key rotation and session revocation must happen before history rewriting.

The current checkout scan found secret-like material in local ignored files, old deployment outputs, a local server environment file, a generated M1 environment file, browser profile state, and a notification test script. The local scan report is redacted and was stored under the OS temporary directory. No secret values belong in this document or in Git.

## Before rewriting

1. Rotate/revoke the service credentials and browser sessions identified in the M1 report.
2. Coordinate a maintenance window. Rewriting changes every affected commit ID; collaborators must stop pushing and re-clone or carefully reset afterward.
3. Preserve a private offline backup of the repository and verify the WIP branch and backup branch. Do not put that backup in OneDrive or another synchronized folder.
4. Install `git-filter-repo` and verify it is available:

   ```powershell
   python -m pip install git-filter-repo
   git filter-repo --version
   ```

5. Create a bundle of all local refs outside the working directory, then use it as the mirror-clone source. This includes unpushed local work without printing or copying the remote URL:

   ```powershell
   $bundle = Join-Path $env:TEMP 'tabweb-before-purge.bundle'
   git bundle create $bundle --all
   git clone --mirror $bundle tabweb-teachers-purge.git
   Set-Location tabweb-teachers-purge.git
   ```

   The source remote is configured as `origin`. Before any approved force push, compare the rewritten refs with the remote and coordinate all collaborators. The bundle is a sensitive backup because it contains the old history.

## Combined path purge and inline replacement

Run only after confirming every path against `git log --all --name-only` and preparing the private replacement file below. This removes named paths from every rewritten commit and replaces exact literals in all remaining files.

```powershell
$replaceFile = Join-Path $env:TEMP 'tabweb-filter-replacements.txt'
# Create/edit this file locally with literal:secret==>***REMOVED*** entries.
git filter-repo --sensitive-data-removal --replace-text $replaceFile --invert-paths `
  --path .qa/ `
  --path .env `
  --path .env.production `
  --path server/.env `
  --path HOSTINGER_FINAL_PACKAGE/ `
  --path hostinger-upload/ `
  --path temp-chunks/ `
  --path HOSTINGER_FINAL_PACKAGE.zip `
  --path frontend.zip `
  --path frontend-update.zip `
  --path dist.tar.gz `
  --path dist-fixed.zip `
  --path deploy.zip `
  --path dist.zip
Remove-Item -LiteralPath $replaceFile -Force
```

If history inspection finds additional credential-bearing files, add their exact paths before running. A path purge permanently removes those files from all rewritten history, including any useful deployment artifacts or QA evidence stored there.

Some credentials were embedded in tracked source, tests, and documentation. Populate the replacement file from the credential owner’s secure vault or local incident-response records; do not copy values into tickets, commits, or chat. Verify the exact `git-filter-repo` version’s option interaction in the mirror clone first. Never rerun a rewrite without revalidating refs and backup snapshots.

## Verification before any push

```powershell
gitleaks git . --redact --no-banner
git log --all --oneline --decorate -20
git fsck --full
git rev-list --all | ForEach-Object { git grep -n -E '^(<<<<<<< |=======|>>>>>>> )' $_ -- }
```

Also rerun the full working-tree scanner and secret-specific checks. Confirm no `.qa`, environment, profile, cookie, deployment bundle, or temp artifact remains in any reachable ref. GitHub/Git hosting may retain cached objects, forks, PR refs, and clones; `filter-repo` cannot revoke them.

## What a history rewrite breaks

- Every commit ID after a rewritten tree changes; branches and tags must be reconciled.
- Existing PRs, reviews, signed commits, release tags, and commit links may become invalid or confusing.
- Collaborators with old clones can reintroduce the exposed history by pushing old refs.
- Remote branch protection may reject force pushes. Hosting caches, forks, mirrors, artifacts, and backups need separate cleanup requests.
- Removing `.qa`, deployment bundles, environment files, or archives from history permanently removes those artifacts for anyone relying on the repository as their only copy.
- Force pushing is intentionally excluded from this preparation. It requires explicit approval after rotation and verification.
