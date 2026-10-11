import { readFileSync, statfsSync } from 'node:fs';

/**
 * 主机指标采集（phase: clklog-analytics-ops-console-v1）。
 *
 * 硬约束：**不执行任何 shell 命令**（PRD AC5），只读 /proc 与 fs.statfs。
 * 所有解析为纯函数（内容进、对象出），便于单测与容错。
 */

export interface HostMemory {
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface HostLoad {
  load1: number;
  load5: number;
  load15: number;
}

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 解析 /proc/meminfo（kB 单位）。缺 MemTotal/MemAvailable 时返回 null */
export function parseMemInfo(content: string): HostMemory | null {
  const total = /MemTotal:\s+(\d+)\s*kB/.exec(content);
  const available = /MemAvailable:\s+(\d+)\s*kB/.exec(content);
  if (!total || !available) return null;
  const totalBytes = Number(total[1]) * 1024;
  const availableBytes = Number(available[1]) * 1024;
  if (totalBytes <= 0) return null;
  return {
    totalBytes,
    availableBytes,
    usedPercent: round1(((totalBytes - availableBytes) / totalBytes) * 100),
  };
}

/** 解析 /proc/loadavg：'2.46 3.65 4.73 5/1674 1883111' */
export function parseLoadAvg(content: string): HostLoad | null {
  const parts = content.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
  return { load1: parts[0], load5: parts[1], load15: parts[2] };
}

/** 磁盘用量（fs.statfs，Node 18.15+；生产 Node v24） */
export function diskUsage(path: string): DiskUsage | null {
  try {
    const stats = statfsSync(path);
    const totalBytes = Number(stats.blocks) * stats.bsize;
    const freeBytes = Number(stats.bavail) * stats.bsize;
    if (totalBytes <= 0) return null;
    return {
      path,
      totalBytes,
      freeBytes,
      usedPercent: round1(((totalBytes - freeBytes) / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

function readProc(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 聚合主机内存与负载；任一读取失败则该项为 null（前端展示「不可用」） */
export function collectHostMetrics(diskPaths: string[]): {
  memory: HostMemory | null;
  load: HostLoad | null;
  disks: DiskUsage[];
} {
  const memRaw = readProc('/proc/meminfo');
  const loadRaw = readProc('/proc/loadavg');
  return {
    memory: memRaw ? parseMemInfo(memRaw) : null,
    load: loadRaw ? parseLoadAvg(loadRaw) : null,
    disks: diskPaths
      .map((path) => diskUsage(path))
      .filter((disk): disk is DiskUsage => disk !== null),
  };
}
