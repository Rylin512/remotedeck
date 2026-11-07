import { loadState, getState, saveState } from '../server/config.js';
import { hashPassword, validatePassword } from '../server/auth.js';

const password = process.argv[2];
if (!password) {
  console.error('用法: node scripts/reset-password.js "新的强密码"');
  console.error('执行后所有已登录设备都会退出。');
  process.exit(1);
}
const error = validatePassword(password);
if (error) {
  console.error(error);
  process.exit(1);
}

await loadState();
const state = getState();
state.password = await hashPassword(password);
state.sessions = [];
await saveState();
console.log('密码已重置，所有设备已退出。请重新启动 RemoteDeck 并登录。');
