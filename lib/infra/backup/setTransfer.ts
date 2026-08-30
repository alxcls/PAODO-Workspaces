// Set-level transfer to and from S3. Object I/O lives in s3Sink/s3Source; this owns the ordering
// rule that makes a set atomic: members go up first, backup.json last. That final write is the set's
// commit point, so a push that dies partway leaves invisible orphans rather than a half-set.
import path from "path";
import { pushArchive } from "./s3Sink";
import { s3Source, type ObjectSource } from "./s3Source";
import { sha256File, verifyArchive } from "../archive/core";
import { createAuditLogger } from "../logger";
import { SET_MANIFEST_MEMBER, type BackupSet } from "../../archive/setManifest";

const audit = createAuditLogger("backup");

export type PushObject = (localPath: string, key: string) => Promise<string>;

/**
 * Pushes every member, then the marker. Any member failure rejects before the marker is written, so
 * the set never becomes visible to a reader that trusts the marker's presence. Returns the URLs in
 * push order. `push` is injectable so the ordering guarantee tests without a network.
 */
export async function pushSet(
  setDir: string,
  manifest: BackupSet,
  prefix: string,
  push: PushObject = pushArchive,
): Promise<string[]> {
  const bytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  try {
    const urls: string[] = [];
    for (const entry of manifest.entries) {
      urls.push(await push(path.join(setDir, entry.file), `${prefix}/${entry.file}`));
    }
    urls.push(await push(path.join(setDir, SET_MANIFEST_MEMBER), `${prefix}/${SET_MANIFEST_MEMBER}`));
    audit.info(
      {
        event: "backup_set_pushed",
        outcome: "set_pushed_offsite",
        instance: manifest.instance,
        setId: manifest.id,
        prefix,
        members: manifest.entries.length,
        bytes,
      },
      "backup set pushed to S3",
    );
    return urls;
  } catch (err) {
    audit.error(
      {
        event: "backup_set_push_failed",
        outcome: "set_not_pushed_offsite",
        err,
        instance: manifest.instance,
        setId: manifest.id,
        prefix,
      },
      "backup set push to S3 failed before the commit marker",
    );
    throw err;
  }
}

export interface SetVerifyResult {
  ok: boolean;
  manifest?: BackupSet;
  problems: string[];
}

/**
 * Pulls a set into `workDir` and checks it end to end. The marker must be present — a set without it
 * is torn or never existed. Then every member must match the sha256 backup.json recorded for it and
 * pass its own internal manifest check. Downloads but never applies: putting the data back is a later
 * branch; this is what lets you trust a backup before the day you need it.
 */
export async function verifySet(
  prefix: string,
  workDir: string,
  source: ObjectSource = s3Source(),
): Promise<SetVerifyResult> {
  const result = await checkSet(prefix, workDir, source);
  if (result.ok) {
    audit.info(
      {
        event: "remote_backup_verified",
        outcome: "remote_set_trusted",
        prefix,
        members: result.manifest?.entries.length,
      },
      "remote backup set verified",
    );
  } else {
    audit.warn(
      {
        event: "remote_backup_verification_failed",
        outcome: "remote_set_untrusted",
        prefix,
        problems: result.problems,
      },
      "remote backup set failed verification",
    );
  }
  return result;
}

async function checkSet(prefix: string, workDir: string, source: ObjectSource): Promise<SetVerifyResult> {
  const markerKey = `${prefix}/${SET_MANIFEST_MEMBER}`;
  if (!(await source.exists(markerKey))) {
    return { ok: false, problems: [`${prefix}: no ${SET_MANIFEST_MEMBER} — the set is incomplete or does not exist`] };
  }
  const manifest = JSON.parse(await source.getText(markerKey)) as BackupSet;

  const problems: string[] = [];
  for (const entry of manifest.entries) {
    const local = path.join(workDir, entry.file);
    try {
      await source.pull(`${prefix}/${entry.file}`, local);
    } catch (err) {
      problems.push(`${entry.file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if ((await sha256File(local)) !== entry.sha256) {
      problems.push(`${entry.file}: sha256 does not match ${SET_MANIFEST_MEMBER}`);
      continue;
    }
    const inner = await verifyArchive(local);
    if (!inner.ok) problems.push(...inner.problems.map((p) => `${entry.file}: ${p}`));
  }
  return { ok: problems.length === 0, manifest, problems };
}
