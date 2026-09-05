# Offsite backups with restic

One responsibility each: **PAODO builds a correct, self-describing backup set** (graph + database +
drives + workspaces + manifest) with `npm run backup:all`; **restic owns everything after** — offsite
push, encryption, dedup, pruning, repo checks.

[`scripts/backup-offsite.sh`](../scripts/backup-offsite.sh) is the seam: it builds the set and hands
it to restic, which ships only changed chunks and prunes on a rolling window, so the bucket stays
bounded. Restic reuses the box's `.env` `S3_*` values — no new credentials. Recovery depends on two
secrets; keep both safe or backups are unrecoverable: the **repo password** (`restic-password` file)
and the **S3 keys** in `.env`.

## One-time setup per box

1. **Install restic** (`apt-get install -y restic`).
2. **Create the password file** next to `.env`, and store the value in a password manager:
   ```bash
   openssl rand -base64 32 > restic-password
   chmod 600 restic-password
   ```
3. **Initialise the repo:** `npm run backup:offsite -- --init`
4. **Schedule it** — installs a nightly systemd timer running `backup-offsite.sh`. Never automatic
   (a clone with no S3 must not get a failing nightly job); this is the deliberate opt-in, per box:
   ```bash
   npm run backup:schedule      # 03:<stable-per-host-minute> nightly; self-elevates with sudo
   ```
   Each box gets a distinct minute from its hostname so they never hit S3 on the same tick; override
   with `BACKUP_HOUR` / `BACKUP_MINUTE`, set the runtime user with `BACKUP_USER`. Inspect with
   `systemctl list-timers paodo-backup.timer` and `journalctl -u paodo-backup.service`; remove with
   `bash scripts/install-backup-schedule.sh --uninstall`. A run on a box with no S3 fails fast and
   writes nothing.

## Running it

`npm run backup:offsite` builds the set in the `app` container, copies it to the host, runs `restic
backup`, prunes with `--keep-daily 7 --keep-weekly 4 --keep-monthly 12 --keep-yearly 1`, then a
structural `restic check` — a year of recovery points in ~24 snapshots. Against `npm run dev`:

```bash
COMPOSE_FILES='-f docker-compose.yml -f docker-compose.dev.yml' npm run backup:offsite
```

## Restore runbook

Deliberate, operator-run disaster recovery: you SSH in and put the box back to one past day. Two
halves mirror backup — **restic fetches the set to disk**, then **`backup:restore` applies it into
live state**. Needs `restic`, the `.env` S3 keys and the `restic-password` file. Export the repo env
(or run from the repo dir, which maps it for you):

```bash
export RESTIC_REPOSITORY="s3:s3.fr-par.scw.cloud/<box-bucket>"
export RESTIC_PASSWORD_FILE="$PWD/restic-password"
export AWS_ACCESS_KEY_ID=<S3_ACCESS_KEY_ID from .env>
export AWS_SECRET_ACCESS_KEY=<S3_SECRET_ACCESS_KEY from .env>
```

**1. Pick a day and fetch it** — plain restic:

```bash
restic snapshots                                    # list restorable days
restic restore <snapshot-id> --target ~/restore     # restore a whole day
```

Restore into a path with room and **not on tmpfs** (a set is a few GB; some hosts mount `/tmp` as a
small RAM disk). The set lands at `~/restore/<instance>/<stamp>-<id>/` (the dir holding `backup.json`).

**2. Take the app down, apply the set, bring it back.** The app must be stopped — `backup:restore`
overwrites the live database, graph and registry in place, and those are read once at startup. Apply
in a one-off container on the same volume:

```bash
SET=~/restore/<instance>/<stamp>-<id>
docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml stop app
docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml \
  run --rm -v "$SET":/restore:ro app npm run backup:restore -- /restore
docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml start app
```

`backup:restore` **verifies every archive against `backup.json` and its own manifest before writing a
byte** — a torn set, or one from another deployment, aborts with nothing changed. It restores in
dependency order (workspaces, database + registry, drives, then graph), keyed by each workspace's
**original id** so conversation rows, drive connections and graph edges stay connected; a set
predating drives carries none and restore skips it. Overwriting live state, or a set from a
**different** deployment, requires `--force` (append it after `/restore`).

Verification is all-or-nothing but writing is not: once the first byte lands, a mid-restore failure
leaves the box **half-restored**. The audit log's `phase` field records where it stopped — fix the
cause and re-run rather than starting the app on partial state.

```bash
restic check   # verify repo structure any time (--read-data re-hashes, slow)
restic mount /mnt/restic   # browse snapshots to grab a single file by hand
```

## Notes

- Retention lives in the script (`7 daily + 4 weekly + 12 monthly + 1 yearly`); override any of
  `KEEP_DAILY` / `KEEP_WEEKLY` / `KEEP_MONTHLY` / `KEEP_YEARLY`.
- Restic is the only offsite path; `backup:all` builds a set on disk and restic ships it.
- Each box has its own bucket and repo, so losing one never touches the other.
