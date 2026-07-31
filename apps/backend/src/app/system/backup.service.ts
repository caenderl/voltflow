import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BackupDump,
  BackupStatus,
  LocalBackups,
  OffsiteStatus,
} from '@org/shared-types';

/** Dumps written by scripts/backup.sh (the `voltflow-prod-…` variant too). */
const DUMP_RE = /^voltflow-.*\.sql\.gz$/;
/** Status file scripts/backup-offsite.sh writes after every run. */
const STATUS_FILE = 'status.json';

/**
 * Reads both backup tiers off the filesystem:
 *   - the on-host dumps in BACKUP_DIR (stat only — the .gz is never opened), and
 *   - `status.json`, the summary scripts/backup-offsite.sh leaves behind after
 *     each restic run.
 *
 * Deliberately no restic call: the backend has neither the binary nor the repo
 * password, and a live `restic snapshots` would hit the cloud repo on every
 * page load. Each tier degrades to null on its own when unavailable (dir not
 * mounted, off-site not set up), so one missing source never fails the other.
 */
@Injectable()
export class BackupService {
  private readonly log = new Logger(BackupService.name);
  /** In prod the host's ./backups is bind-mounted here read-only. */
  private readonly backupDir = process.env.BACKUP_DIR ?? './backups';

  async getStatus(): Promise<BackupStatus> {
    const [local, offsite] = await Promise.all([this.readLocal(), this.readOffsite()]);
    return { time: new Date().toISOString(), local, offsite };
  }

  /** List the rotated dumps, oldest first. Null when the dir is unreadable. */
  private async readLocal(): Promise<LocalBackups | null> {
    let names: string[];
    try {
      names = await readdir(this.backupDir);
    } catch (e) {
      this.log.debug(`backup dir ${this.backupDir} unreadable: ${(e as Error).message}`);
      return null;
    }

    const dumps: BackupDump[] = [];
    for (const file of names.filter((n) => DUMP_RE.test(n))) {
      try {
        const s = await stat(join(this.backupDir, file));
        // mtime, not the name: the file name carries the host's local time with
        // no offset and this process may well run in UTC.
        dumps.push({ file, time: s.mtime.toISOString(), sizeBytes: s.size });
      } catch {
        // Vanished mid-listing (rotation ran) — just skip it.
      }
    }
    dumps.sort((a, b) => a.time.localeCompare(b.time));

    return {
      dir: this.backupDir,
      dumps,
      totalBytes: dumps.reduce((sum, d) => sum + d.sizeBytes, 0),
    };
  }

  /** Parse the off-site status file. Null when absent or malformed. */
  private async readOffsite(): Promise<OffsiteStatus | null> {
    const path = join(this.backupDir, STATUS_FILE);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as OffsiteStatus;
      // Guard against a half-written file: `time` is the one field every branch
      // of the script writes, so its absence means the JSON is not ours.
      if (typeof parsed?.time !== 'string') return null;
      return { ...parsed, snapshots: parsed.snapshots ?? [] };
    } catch (e) {
      this.log.debug(`no off-site status at ${path}: ${(e as Error).message}`);
      return null;
    }
  }
}
