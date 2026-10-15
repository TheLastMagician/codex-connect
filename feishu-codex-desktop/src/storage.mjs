import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const dataArgument=process.argv.indexOf('--codex-connect-data-dir');
export const dataDir = process.env.FEISHU_CODEX_DATA_DIR ||
  (dataArgument>=0?process.argv[dataArgument+1]:null) || path.join(os.homedir(), '.codex-feishu-desktop');
export function secureDirectory(dir = dataDir) {
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  if (process.platform === 'win32') {
    const who = spawnSync('whoami.exe', [], {encoding:'utf8', windowsHide:true});
    if (who.status !== 0 || !who.stdout.trim()) throw new Error('无法确认当前 Windows 用户');
    const acl = spawnSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${who.stdout.trim()}:(OI)(CI)F`], {windowsHide:true, encoding:'utf8'});
    if (acl.status !== 0) throw new Error('无法限制配置目录的 Windows 访问权限');
  }
}
export function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function writeJson(name, value) {
  fs.mkdirSync(dataDir, {recursive:true, mode:0o700});
  const target = path.join(dataDir,name);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value,null,2), {mode:0o600, flag:'wx'});
    fs.renameSync(temp,target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function config() {
  const result = readJson('config.json',{});
  const appId = process.env.FEISHU_APP_ID || result.appId;
  const appSecret = process.env.FEISHU_APP_SECRET || result.appSecret;
  if (!Array.isArray(result.allowedOpenIds)) result.allowedOpenIds = [];
  return {...result,appId,appSecret};
}
