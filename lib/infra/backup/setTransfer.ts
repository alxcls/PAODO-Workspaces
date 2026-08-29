// Set-level transfer to and from S3. Object I/O lives in s3Sink/s3Source; this owns the ordering
// rule that makes a set atomic: members go up first, backup.json last. That final write is the set's
// commit point, so a push that dies partway leaves invisible orphans rather than a half-set.
import path from "path";
import { pushArchive } from "./s3Sink";
import { SET_MANIFEST_MEMBER, type BackupSet } from "../../archive/setManifest";

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
  const urls: string[] = [];
  for (const entry of manifest.entries) {
    urls.push(await push(path.join(setDir, entry.file), `${prefix}/${entry.file}`));
  }
  urls.push(await push(path.join(setDir, SET_MANIFEST_MEMBER), `${prefix}/${SET_MANIFEST_MEMBER}`));
  return urls;
}
