import { Component, computed, input } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { BackupStatus, OffsiteSnapshot } from '@org/shared-types';
import { CHART_COLORS } from '../../core/chart-utils';
import { MetricTileComponent } from '../../ui/metric-tile/metric-tile.component';
import { type SysPoint, backupSizeChart } from './system-charts';

const MB = 1024 ** 2;
const HOUR_MS = 3600 * 1000;
/** Both tiers run nightly, so a backup older than this missed a night. */
const STALE_H = 26;
/** Two missed nights — treat as broken, not late. */
const BROKEN_H = 50;

/** Green while a nightly backup is on schedule, amber late, red missing. */
function ageColor(hours: number | null): string {
  if (hours == null || hours >= BROKEN_H) return CHART_COLORS.import; // red
  if (hours >= STALE_H) return CHART_COLORS.production; // amber
  return CHART_COLORS.export; // green
}

/** "vor 8 h" / "vor 35 min" / "vor 3 d" — coarse on purpose. */
function ago(hours: number | null): string {
  if (hours == null) return '–';
  if (hours < 1) return `vor ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `vor ${Math.round(hours)} h`;
  return `vor ${Math.round(hours / 24)} d`;
}

/** Display order + label for known tags — DB first (the important one), then
 *  config; an unlisted tag would sort last instead of landing wherever its
 *  name happens to fall alphabetically. */
const TAG_LABELS: Record<string, string> = { db: 'Datenbank', config: 'Konfiguration' };
const TAG_ORDER = Object.keys(TAG_LABELS);

function tagRank(tag: string): number {
  const i = TAG_ORDER.indexOf(tag);
  return i === -1 ? TAG_ORDER.length : i;
}

/** Auto-scaled size: the config snapshots are kilobytes, the repo is megabytes. */
function bytes(n: number): string {
  const [value, unit] =
    n >= 1024 * MB ? [n / (1024 * MB), 'GB'] : n >= MB ? [n / MB, 'MB'] : n >= 1024 ? [n / 1024, 'KB'] : [n, 'B'];
  const digits = unit === 'B' ? 0 : 1;
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${unit}`;
}

/**
 * The two backup tiers side by side: the on-host dumps (age, rotation fill,
 * size trend) and the off-site restic repo (last run, repo size, snapshots).
 * Purely presentational — the parent fetches the status.
 */
@Component({
  selector: 'app-system-backups',
  standalone: true,
  imports: [NgxEchartsDirective, MetricTileComponent],
  templateUrl: './system-backups.component.html',
  styleUrl: './system-backups.component.scss',
})
export class SystemBackupsComponent {
  readonly status = input.required<BackupStatus | null>();

  // --- local dumps -----------------------------------------------------------
  private readonly local = computed(() => this.status()?.local ?? null);
  readonly hasLocal = computed(() => (this.local()?.dumps.length ?? 0) > 0);

  /** Hours since the newest dump; null when there is none. */
  readonly localAgeH = computed(() => {
    const newest = this.local()?.dumps.at(-1);
    return newest ? (Date.now() - new Date(newest.time).getTime()) / HOUR_MS : null;
  });
  readonly localValue = computed(() => (this.hasLocal() ? ago(this.localAgeH()) : '–'));
  readonly localColor = computed(() => ageColor(this.hasLocal() ? this.localAgeH() : null));
  readonly localSub = computed(() => {
    const l = this.local();
    if (!l) return 'Verzeichnis nicht eingebunden';
    if (!l.dumps.length) return 'keine Dumps gefunden';
    const newest = l.dumps.at(-1);
    return `${l.dumps.length} Dumps · ${bytes(l.totalBytes)} · neuester ${bytes(newest?.sizeBytes ?? 0)}`;
  });
  readonly localChart = computed(() =>
    backupSizeChart(
      (this.local()?.dumps ?? []).map(
        (d) => [new Date(d.time).getTime(), d.sizeBytes / MB] as SysPoint,
      ),
      this.localColor(),
    ),
  );

  // --- off-site (restic) -----------------------------------------------------
  readonly offsite = computed(() => this.status()?.offsite ?? null);

  private readonly offsiteAgeH = computed(() => {
    const o = this.offsite();
    return o ? (Date.now() - new Date(o.time).getTime()) / HOUR_MS : null;
  });
  readonly offsiteValue = computed(() => {
    const size = this.offsite()?.repoSizeBytes;
    return size != null ? bytes(size) : '–';
  });
  /** A failed run outranks a fresh one: red even if it ran an hour ago. */
  readonly offsiteColor = computed(() => {
    const o = this.offsite();
    if (!o) return CHART_COLORS.import;
    return o.ok && o.checkOk !== false ? ageColor(this.offsiteAgeH()) : CHART_COLORS.import;
  });
  readonly offsiteState = computed(() => {
    const o = this.offsite();
    if (!o) return 'noch kein Lauf';
    if (!o.ok) return `fehlgeschlagen (${o.failedStage ?? 'unbekannt'})`;
    if (o.checkOk === false) return 'Prüfung fehlgeschlagen';
    return 'Prüfung ok';
  });
  readonly offsiteSub = computed(() => {
    const o = this.offsite();
    if (!o) return 'Off-Site-Status noch nicht geschrieben';
    const parts = [`${o.snapshotCount ?? '?'} Snapshots`, this.offsiteState(), ago(this.offsiteAgeH())];
    return parts.join(' · ');
  });
  readonly retentionLabel = computed(() => {
    const r = this.offsite()?.retention;
    return r ? `${r.daily}d / ${r.weekly}w / ${r.monthly}m` : '';
  });
  readonly repository = computed(() => this.offsite()?.repository ?? '');

  /** Newest snapshot per tag — the whole history would just be noise here. */
  readonly latestSnapshots = computed<OffsiteSnapshot[]>(() => {
    const byTag = new Map<string, OffsiteSnapshot>();
    for (const s of this.offsite()?.snapshots ?? []) {
      const seen = byTag.get(s.tag);
      if (!seen || s.time > seen.time) byTag.set(s.tag, s);
    }
    return [...byTag.values()].sort(
      (a, b) => tagRank(a.tag) - tagRank(b.tag) || a.tag.localeCompare(b.tag),
    );
  });

  snapshotLabel(s: OffsiteSnapshot): string {
    return TAG_LABELS[s.tag] ?? s.tag;
  }

  /** "63,1 MB · 3,0 MB neu · 111 s" — what dedup actually saved that night. */
  snapshotDetail(s: OffsiteSnapshot): string {
    const parts = [bytes(s.sizeBytes)];
    // 0 added bytes is the normal case for the config snapshot: nothing changed,
    // so restic stored nothing at all — "0,0 KB neu" would read like an error.
    if (s.addedBytes === 0) parts.push('unverändert');
    else if (s.addedBytes != null) parts.push(`${bytes(s.addedBytes)} neu`);
    if (s.durationSec != null) parts.push(`${Math.round(s.durationSec)} s`);
    return parts.join(' · ');
  }

  snapshotTime(s: OffsiteSnapshot): string {
    return new Date(s.time).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
