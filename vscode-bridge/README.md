# RemoteDeck VS Code Bridge

这个扩展让 RemoteDeck 手机控制台可以：

- 打开 VS Code 里的 Claude Code 面板；
- 在 VS Code 集成终端中启动 Claude Code；
- 向 Claude Code 终端发送短指令（实验性）；
- 按会话 ID 恢复 Claude Code 历史对话；
- 打开文件或目录。

安装：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-vscode-bridge.ps1
```

然后完全退出并重新打开 VS Code。

它注册了 `vscode://remotedeck.bridge/...` URI 处理器，只接受固定的几个动作：

- `claude?mode=panel`
- `claude?mode=terminal`
- `prompt?text=...`
- `openSession?sessionId=...`
- `open?path=...&line=...`
- `command?name=claude-vscode.sidebar.open`

注意：向终端发送指令依赖 Claude Code 扩展的终端 UI，可能随扩展版本变化。长指令或需要精确控制时，请使用 RemoteDeck 自带的 Claude 会话。
