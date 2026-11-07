import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function claudeSettingsPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

export function readClaudeSettings() {
  const file = claudeSettingsPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return { file, data, raw, error: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { file, data: {}, raw: null, error: null };
    return { file, data: null, raw: null, error: err.message };
  }
}

export function officialStatus() {
  const { file, data, error } = readClaudeSettings();
  return {
    enabled: Boolean(data?.remoteControlAtStartup),
    disabled: Boolean(data?.disableRemoteControl),
    settingsPath: file,
    error,
    available: !error && data !== null,
  };
}

export async function setOfficialRemoteControl(enabled) {
  const { file, data, error, raw } = readClaudeSettings();
  if (error || !data) {
    throw Object.assign(new Error(`无法读取 Claude 设置：${error || '格式不正确'}`), { status: 409 });
  }
  if (raw != null) {
    const backup = `${file}.remotedeck-backup-${Date.now()}`;
    await fsp.copyFile(file, backup);
  }
  if (enabled) data.remoteControlAtStartup = true;
  else delete data.remoteControlAtStartup;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return officialStatus();
}
