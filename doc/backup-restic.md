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

4. **Schedule it** nightly (root `crontab -e`, or your scheduler of choice), a different minute per
   box so they don't hit S3 at once:

   ```cron
   17 3 * * * cd /root/PAODO_WS && /usr/bin/npm run backup:offsite >> /var/log/paodo-backup.log 2>&1
   ```

## Running it

```bash
npm run backup:offsite
```

It builds the set in the `app` container, copies it to the host, runs `restic backup`, prunes with
`--keep-daily 7 --keep-weekly 4`, then runs a structural `restic check`. Against `npm run dev`, point
it at the dev overlay:

```bash
COMPOSE_FILES='-f docker-compose.yml -f docker-compose.dev.yml' npm run backup:offsite
```

## Restore runbook

Needs `restic`, the `.env` S3 keys, and the `restic-password` file. Export the repo env (or run from
the repo dir where the script maps it for you):

```bash
export RESTIC_REPOSITORY="s3:s3.fr-par.scw.cloud/<box-bucket>"
export RESTIC_PASSWORD_FILE="$PWD/restic-password"
export AWS_ACCESS_KEY_ID=<S3_ACCESS_KEY_ID from .env>
export AWS_SECRET_ACCESS_KEY=<S3_SECRET_ACCESS_KEY from .env>
```

```bash
restic snapshots                                      # list restorable days
restic restore <snapshot-id> --target /var/lib/paodo/restore   # restore a whole day
restic mount /mnt/restic                              # browse snapshots to grab one file
restic check                                          # verify structure (--read-data re-hashes, slow)
```

Apply a restored set the same way as one built by `backup:all`.

## Notes

- Retention lives in the script (`--keep-daily 7 --keep-weekly 4`); override with `KEEP_DAILY` /
  `KEEP_WEEKLY`.
- Restic is the only offsite path. The app's former direct-to-S3 layer (`--push`, `backup:verify-remote`,
  `s3Sink`/`s3Source`/`setTransfer`) has been removed; `backup:all` now only builds a set on disk.
- Each box has its own bucket and repo, so losing one never touches the other.
