const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXTENSION_VERSION = '0.1.2';
const READY_DIR = path.join(os.homedir(), '.remotedeck');
const READY_FILE = path.join(READY_DIR, 'bridge-state.json');

function writeReadyState() {
  try {
    fs.mkdirSync(READY_DIR, { recursive: true });
    fs.writeFileSync(READY_FILE, JSON.stringify({
      version: EXTENSION_VERSION,
      capabilities: ['openSession', 'reopenSession', 'prompt'],
      pid: process.pid,
      workspaceFolders: (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
      updatedAt: new Date().toISOString(),
    }), 'utf8');
  } catch {}
}

const ALLOWED_COMMANDS = new Set([
  'claude-vscode.sidebar.open',
  'claude-vscode.terminal.open',
  'claude-vscode.focus',
  'claude-vscode.newConversation',
  'workbench.action.files.saveAll',
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function openClaude(mode) {
  if (mode === 'terminal') {
    await vscode.commands.executeCommand('claude-vscode.terminal.open');
    return;
  }
  try {
    await vscode.commands.executeCommand('claude-vscode.sidebar.open');
  } catch {
    await vscode.commands.executeCommand('claude-vscode.terminal.open');
  }
}

async function sendPrompt(text) {
  if (!text) throw new Error('指令为空');
  await vscode.commands.executeCommand('claude-vscode.terminal.open');
  await delay(1600);
  let terminal = vscode.window.activeTerminal;
  if (!terminal) {
    terminal = vscode.window.terminals.find((t) => /claude/i.test(t.name)) || vscode.window.terminals.at(-1);
  }
  if (!terminal) throw new Error('找不到 VS Code 终端');
  terminal.show(true);
  terminal.sendText(text, true);
  vscode.window.showInformationMessage('RemoteDeck：指令已发送到 VS Code 的 Claude 终端。');
}

async function openClaudeSession(sessionId) {
  if (!/^[0-9a-f-]{20,}$/i.test(String(sessionId || ''))) throw new Error('无效的会话 ID');
  const last = globalThis.__remotedeckLastOpen;
  if (last && last.sessionId === sessionId && Date.now() - last.at < 5000) return;
  globalThis.__remotedeckLastOpen = { sessionId, at: Date.now() };
  // Match the Claude extension's own "open in editor" call: the fifth argument
  // asks it to reuse/focus an existing panel instead of creating a new chat.
  await vscode.commands.executeCommand(
    'claude-vscode.editor.open',
    sessionId,
    undefined,
    undefined,
    undefined,
    true,
    { programmatic: true },
  );
}

async function closeClaudeTabs(title) {
  const wanted = String(title || '').trim();
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const claudeTabs = tabs.filter((tab) => {
    const input = tab.input;
    return input instanceof vscode.TabInputWebview
      && String(input.viewType || '').toLowerCase().includes('claude');
  });
  let target = wanted ? claudeTabs.filter((tab) => String(tab.label || '').includes(wanted)) : claudeTabs;
  if (!target.length && claudeTabs.length === 1) target = claudeTabs;
  for (const tab of target) {
    try {
      await vscode.window.tabGroups.close(tab);
    } catch {}
  }
}

async function openPath(target, line) {
  const uri = vscode.Uri.file(target);
  if (line) {
    const position = new vscode.Position(Math.max(0, Number(line) - 1), 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position) });
  } else {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
}

async function handleUri(uri) {
  const action = uri.path.replace(/^\/+/, '') || 'claude';
  const params = new URLSearchParams(uri.query || '');
  switch (action) {
    case 'claude':
      await openClaude(params.get('mode') === 'terminal' ? 'terminal' : 'panel');
      break;
    case 'prompt':
      await sendPrompt(params.get('text') || '');
      break;
    case 'openSession':
      if (params.get('force') === '1') {
        await closeClaudeTabs(params.get('title') || '');
        await delay(250);
      }
      await openClaudeSession(params.get('sessionId') || '');
      break;
    case 'open':
      await openPath(params.get('path') || '', params.get('line'));
      break;
    case 'command': {
      const command = params.get('name') || '';
      if (!ALLOWED_COMMANDS.has(command)) throw new Error('不允许的命令');
      await vscode.commands.executeCommand(command);
      break;
    }
    default:
      vscode.window.showWarningMessage(`RemoteDeck：未知操作 ${action}`);
  }
}

function activate(context) {
  writeReadyState();
  const heartbeat = setInterval(writeReadyState, 15_000);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => writeReadyState()));
  context.subscriptions.push(vscode.commands.registerCommand('remotedeck.openClaude', async () => {
    await openClaude('panel');
  }));
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: (uri) => {
      handleUri(uri).catch((err) => {
        vscode.window.showErrorMessage(`RemoteDeck Bridge：${err.message || err}`);
      });
    },
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
