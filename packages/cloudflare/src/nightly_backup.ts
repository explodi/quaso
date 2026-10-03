// SPDX-License-Identifier: MIT
/**
 * The nightly backup with Cloudflare storage (design §5.12, S9.1): the Durable Object
 * writes the service's JSON backup, gzip-compressed, to R2 as
 * `backups/quaso-<UTC time>.json.gz`, deletes the backup files older than
 * `BACKUP_RETENTION_DAYS` (30 by default), and records the backup for the admin page.
 * Point-in-time recovery covers the last 30 days as well; the files are for keeping a copy
 * elsewhere and for moving to another setup (`quaso restore <file>`).
 *
 * The document is read from the service in chunks and compressed as it goes, so the
 * object never holds the uncompressed backup; large files go up in parts. Requests go on
 * meanwhile, so each chunk is read at the state the backup started at: a write in between
 * starts the backup again (`withBackupRetries`), and it is the instance at one moment.
 */
import {
  backupJsonStream,
  type BackupReader,
  type Logger,
  type ServiceApi,
  SYSTEM,
  withBackupRetries,
} from "@quaso/service";

/** Where the files go in the bucket. */
export const BACKUP_PREFIX = "backups/";

/** How long backup files stay, unless `BACKUP_RETENTION_DAYS` says otherwise. */
export const DEFAULT_RETENTION_DAYS = 30;

/** When the nightly backup runs, in UTC. */
export const BACKUP_HOUR_UTC = 3;

/** When a failed backup is tried again. */
export const BACKUP_RETRY_MS = 60 * 60_000;

/** The size of each part of a multipart upload (R2 wants at least 5 MiB, all but the last equal). */
export const PART_SIZE = 8 * 1024 * 1024;

const DAY = 86_400_000;

/** The next nightly backup after `now`: the next 03:00 UTC. */
export function nextBackupTime(now: number): number {
  const date = new Date(now);
  const today = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    BACKUP_HOUR_UTC,
  );
  return today > now ? today : today + DAY;
}

/** `BACKUP_RETENTION_DAYS` as a whole number of days (at least 1), or the default. */
export function retentionDays(value: string | undefined): number {
  const days = Number(value?.trim() || NaN);
  return Number.isInteger(days) && days >= 1 ? days : DEFAULT_RETENTION_DAYS;
}

/** `backups/quaso-20260924T030000Z.json.gz` */
export function backupKey(time: number): string {
  const stamp = new Date(time)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${BACKUP_PREFIX}quaso-${stamp}.json.gz`;
}

/** The backup files' names, with their time, which retention goes by. */
const BACKUP_FILE = /^backups\/quaso-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z\.json\.gz$/;

/** The time in a backup file's name, or null for other files (which stay). */
export function backupTime(key: string): number | null {
  const match = key.match(BACKUP_FILE);
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

export interface NightlyBackupOptions {
  now: number;
  retentionDays: number;
  log: Logger;
  /** Tests make it smaller. */
  partSize?: number;
}

export interface NightlyBackupResult {
  key: string;
  /** Compressed bytes written. */
  size: number;
  /** Old backup files deleted. */
  deleted: string[];
}

/** Writes the backup file, deletes the expired ones, and records the backup. */
export async function writeNightlyBackup(
  service: Pick<ServiceApi, "backupInfo" | "backupTables" | "recordBackup">,
  bucket: R2Bucket,
  options: NightlyBackupOptions,
): Promise<NightlyBackupResult> {
  const key = backupKey(options.now);
  const size = await withBackupRetries(async (attempt) => {
    if (attempt > 1) options.log.info("The data changed during the backup; starting it again");
    // The service's error, which may come out of the compression as another one.
    let failure: unknown = null;
    const reader: BackupReader = {
      backupInfo: (actor, input) => service.backupInfo(actor, input),
      backupTables: (actor, input) =>
        service.backupTables(actor, input).catch((error) => {
          failure = error;
          throw error;
        }),
    };
    const gzip = new CompressionStream("gzip");
    const compressed = backupJsonStream(reader, SYSTEM).pipeThrough({
      // A CompressionStream takes any BufferSource; the document's chunks are Uint8Arrays.
      writable: gzip.writable as WritableStream<Uint8Array>,
      readable: gzip.readable,
    });
    try {
      return await upload(bucket, key, compressed, options.partSize ?? PART_SIZE);
    } catch (error) {
      throw failure ?? error;
    }
  });
  const deleted = await deleteExpired(bucket, options.now - options.retentionDays * DAY);
  await service.recordBackup(SYSTEM, { at: options.now, file: key });
  options.log.info("Nightly backup written", { key, size, deleted });
  return { key, size, deleted };
}

const METADATA = { httpMetadata: { contentType: "application/gzip" } };

/**
 * Writes a stream to R2: in one `put` when it is smaller than a part, otherwise as a
 * multipart upload of equal parts (aborted if anything fails). Returns the size.
 */
export async function upload(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  partSize: number,
): Promise<number> {
  const pending: Uint8Array[] = [];
  let pendingSize = 0;
  let total = 0;
  let multipart: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];

  /** Takes `size` bytes from the front of what is pending. */
  const take = (size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = pending[0];
      const count = Math.min(chunk.byteLength, size - offset);
      out.set(chunk.subarray(0, count), offset);
      offset += count;
      if (count === chunk.byteLength) pending.shift();
      else pending[0] = chunk.subarray(count);
    }
    pendingSize -= size;
    return out;
  };

  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingSize += value.byteLength;
      total += value.byteLength;
      while (pendingSize >= partSize * 2 || (multipart === null && pendingSize > partSize)) {
        multipart ??= await bucket.createMultipartUpload(key, METADATA);
        parts.push(await multipart.uploadPart(parts.length + 1, take(partSize)));
      }
    }
    if (multipart === null) {
      await bucket.put(key, take(pendingSize), METADATA);
      return total;
    }
    // The rest: one full part at most, then the last one.
    while (pendingSize > partSize) {
      parts.push(await multipart.uploadPart(parts.length + 1, take(partSize)));
    }
    if (pendingSize > 0) {
      parts.push(await multipart.uploadPart(parts.length + 1, take(pendingSize)));
    }
    await multipart.complete(parts);
    return total;
  } catch (error) {
    await multipart?.abort().catch(() => {});
    throw error;
  }
}

/** Deletes the backup files taken before `cutoff`, by the time in their names. */
async function deleteExpired(bucket: R2Bucket, cutoff: number): Promise<string[]> {
  const expired: string[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const listed: R2Objects = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    for (const object of listed.objects) {
      const time = backupTime(object.key);
      if (time !== null && time < cutoff) expired.push(object.key);
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  for (let i = 0; i < expired.length; i += 1000) await bucket.delete(expired.slice(i, i + 1000));
  return expired;
}
