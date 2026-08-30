# Offsite backups with restic

One responsibility each: **PAODO's only job is to build a correct, self-describing backup set** (graph
+ database + workspaces + manifest) with `npm run backup:all`. **Restic owns everything after that** —
pushing it offsite, encrypting, deduping, pruning, and checking the repository. The app itself no
longer talks to S3 at all.

[`scripts/backup-offsite.sh`](../scripts/backup-offsite.sh) is the seam: it builds the set, then hands
it to restic, which ships only the chunks that changed since the last run and prunes on a rolling
window. An idle day uploads the database dump plus whatever workspaces changed — not another full
copy — so the bucket stays bounded.

Restic reuses the `S3_*` values already in the box's `.env` — no new credentials.

Recovery depends on two secrets. Keep both safe or the backups are unrecoverable:

- the **repo password** (`restic-password` file), and
- the **S3 keys** in `.env`.

## One-time setup per box

1. **Install restic** (`apt-get install -y restic`, or your distro's package).

2. **Create the password file** next to `.env` and store the value in a password manager:

   ```bash
   openssl rand -base64 32 > restic-password
   chmod 600 restic-password
   ```

3. **Initialise the repo:**

   ```bash
   npm run backup:offsite -- --init
   ```

4. **Schedule it** — one opt-in command that installs a nightly systemd timer running
   `backup-offsite.sh`. Scheduling is never automatic (a clone with no S3 must not get a failing
   nightly job); this is the deliberate step that turns it on, per box:

   ```bash
   npm run backup:schedule      # 03:<stable-per-host-minute> nightly; self-elevates with sudo
   ```

   Each box gets a distinct minute derived from its hostname so they never hit S3 on the same tick;
   override with `BACKUP_HOUR` / `BACKUP_MINUTE`, or set the runtime user with `BACKUP_USER`. Check
   it and see the next run with `systemctl list-timers paodo-backup.timer`, read a run's outcome with
   `journalctl -u paodo-backup.service`, and remove it with
   `bash scripts/install-backup-schedule.sh --uninstall`. A scheduled run on a box with no S3 wired
   fails fast and writes nothing — the worst case is a failed unit in the log, never data loss.

## Running it

```bash
npm run backup:offsite
```

It builds the set in the `app` container, copies it to the host, runs `restic backup`, prunes with
`--keep-daily 7 --keep-weekly 4 --keep-monthly 12 --keep-yearly 1`, then runs a structural
`restic check`. That's a year of recovery points — fine-grained recently, coarse in the tail — for
only ~24 retained snapshots, since restic prunes the churn between the monthly checkpoints. Against
`npm run dev`, point it at the dev overlay:

```bash
COMPOSE_FILES='-f docker-compose.yml -f docker-compose.dev.yml' npm run backup:offsite
```

## Restore runbook

Restore is deliberate, operator-run disaster recovery: you SSH into the box and put it back to one
past day. It is never automatic. Two halves, mirroring backup — **restic fetches the set to disk**
(plain restic, nothing PAODO-specific), then **`backup:restore` applies it back into live state**.

Needs `restic`, the `.env` S3 keys, and the `restic-password` file. Export the repo env (or run from
the repo dir where the script maps it for you):

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

Restore into a path with room and **not on tmpfs** — a set is a few GB, and some hosts mount `/tmp`
as a small RAM disk that fills mid-restore. A dir under `$HOME` or a data volume is safe. The set
lands at `~/restore/<instance>/<stamp>-<id>/` (the dir holding `backup.json`).

**2. Take the app down, apply the set, bring it back.** The app must be stopped: `backup:restore`
overwrites the live database, graph and registry in place, and those are read once at startup — a
running server would both corrupt the swap and ignore the new state. Run the apply in a one-off
container that shares the same workspaces volume:

```bash
SET=~/restore/<instance>/<stamp>-<id>
docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml stop app
docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml \
  run --rm -v "$SET":/restore:ro app npm run backup:restore -- /restore
docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml start app
```

`backup:restore` **verifies every archive against `backup.json` and its own manifest before writing a
byte** — a torn set, or one from another deployment, aborts with nothing changed. It then restores in
dependency order: workspaces (durable home + versioning history checked back out), then the database
and its registry, then the graph. Everything is keyed by each workspace's **original id**, so
conversation rows and graph edges stay connected.

Overwriting existing live state, or restoring a set captured on a **different** deployment, requires
`--force` (append it after `/restore`). A restore onto a healthy box is refused without it.

```bash
restic check   # verify repo structure any time (--read-data re-hashes, slow)
restic mount /mnt/restic   # browse snapshots to grab a single file by hand
```

## Notes

- Retention lives in the script (`7 daily + 4 weekly + 12 monthly + 1 yearly`); override any of
  `KEEP_DAILY` / `KEEP_WEEKLY` / `KEEP_MONTHLY` / `KEEP_YEARLY`.
- Restic is the only offsite path. The app's former direct-to-S3 layer (`--push`, `backup:verify-remote`,
  `s3Sink`/`s3Source`/`setTransfer`) has been removed; `backup:all` now only builds a set on disk.
- Each box has its own bucket and repo, so losing one never touches the other.
