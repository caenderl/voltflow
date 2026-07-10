import { Injectable, Logger } from '@nestjs/common';
import { readFile, statfs } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import type {
  ContainerStatus,
  SystemDisk,
  SystemHealth,
  SystemMemory,
} from '@org/shared-types';

/** Shape of the Docker Engine `/containers/json` list entries we use. */
interface DockerContainer {
  Id: string;
  Names?: string[];
  Image: string;
  State: string;
  Status: string;
}

/**
 * Reads host health directly from the OS: load (os.loadavg), memory
 * (/proc/meminfo, accurate "available"), disk (statfs on the app's filesystem —
 * the container overlay reports the underlying host disk) and the Docker
 * container list (via the mounted engine socket). Everything degrades to a
 * sensible fallback / empty value when a source is unavailable (e.g. macOS dev,
 * no Docker socket), so a single missing source never fails the whole snapshot.
 */
@Injectable()
export class SystemService {
  private readonly log = new Logger(SystemService.name);
  /** Filesystem to report. Container `/` overlay already maps to the host disk;
   *  override for a specific mount. */
  private readonly diskPath = process.env.SYSTEM_DISK_PATH ?? '/';
  private readonly dockerSocket = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

  async getHealth(): Promise<SystemHealth> {
    const [memory, disk, containers] = await Promise.all([
      this.readMemory(),
      this.readDisk(),
      this.readContainers(),
    ]);
    const [avg1, avg5, avg15] = os.loadavg();
    return {
      time: new Date().toISOString(),
      uptimeSec: Math.round(os.uptime()),
      load: { avg1, avg5, avg15, cores: os.cpus().length },
      memory,
      disk,
      containers,
    };
  }

  /** Prefer /proc/meminfo's MemAvailable (accounts for reclaimable cache) over
   *  os.freemem(), which understates real availability. Falls back to os on
   *  non-Linux hosts. */
  private async readMemory(): Promise<SystemMemory> {
    try {
      const text = await readFile('/proc/meminfo', 'utf8');
      const kb = (key: string): number | null => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
        return m ? Number(m[1]) * 1024 : null;
      };
      const total = kb('MemTotal');
      const available = kb('MemAvailable');
      if (total != null && available != null) {
        return { totalBytes: total, usedBytes: total - available, availableBytes: available };
      }
    } catch {
      // /proc not present (e.g. macOS) — fall through to os.
    }
    const total = os.totalmem();
    const available = os.freemem();
    return { totalBytes: total, usedBytes: total - available, availableBytes: available };
  }

  private async readDisk(): Promise<SystemDisk | null> {
    try {
      const s = await statfs(this.diskPath);
      const total = s.blocks * s.bsize;
      const available = s.bavail * s.bsize;
      return { totalBytes: total, usedBytes: total - available, availableBytes: available };
    } catch (e) {
      this.log.warn(`statfs(${this.diskPath}) failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Query the Docker socket for the container list. Returns [] on any failure
   *  (socket not mounted, insufficient permissions, timeout). */
  private async readContainers(): Promise<ContainerStatus[]> {
    try {
      const body = await this.dockerGet('/containers/json?all=1');
      const list = JSON.parse(body) as DockerContainer[];
      return list
        .map((c) => ({
          name: (c.Names?.[0] ?? c.Id ?? '').replace(/^\//, ''),
          image: c.Image,
          state: c.State,
          status: c.Status,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      this.log.debug(`docker query failed: ${(e as Error).message}`);
      return [];
    }
  }

  private dockerGet(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: this.dockerSocket, path, method: 'GET', timeout: 2000 },
        (res) => {
          const status = res.statusCode ?? 500;
          if (status >= 400) {
            res.resume();
            reject(new Error(`docker responded ${status}`));
            return;
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('docker socket timeout')));
      req.end();
    });
  }
}
