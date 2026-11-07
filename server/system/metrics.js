import os from 'node:os';
import fsp from 'node:fs/promises';

let lastCpu = null;

function cpuSample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export function cpuPercent() {
  const current = cpuSample();
  if (!lastCpu) {
    lastCpu = current;
    return null;
  }
  const idle = current.idle - lastCpu.idle;
  const total = current.total - lastCpu.total;
  lastCpu = current;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address });
    }
  }
  return out;
}

export async function systemInfo() {
  let disk = null;
  try {
    const stats = await fsp.statfs(process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\');
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    disk = { total, free, used: total - free, percent: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch {}
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.round(os.uptime()),
    node: process.version,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || '',
    cpuPercent: cpuPercent(),
    memory: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
      percent: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
    },
    disk,
    addresses: localAddresses(),
    user: os.userInfo().username,
  };
}
