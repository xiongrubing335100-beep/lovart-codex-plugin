# Windows 安装与更新

完整图文指南见 [README](../README.md)。需要支持插件的 Codex、Node.js 24+ 和 Python 3.10+（可使用 Codex 自带 Python）。

## 安装

在 PowerShell 执行：

```powershell
codex plugin marketplace add xiongrubing335100-beep/lovart-codex-plugin
codex plugin add lovart@lovart-codex
```

如使用 [Releases](https://github.com/xiongrubing335100-beep/lovart-codex-plugin/releases) 的 Windows ZIP，解压后改用目录作为来源：

```powershell
codex plugin marketplace add 'C:\你的解压位置\lovart-codex-plugin'
codex plugin add lovart@lovart-codex
```

新建 Codex 对话，说「配置lovart的密钥」，打开返回的网页，粘贴 AK、SK 并保存。支持 Ctrl+V、右键粘贴与显示/隐藏。配置过程不会自动生成内容。

## 更新

Git 来源：

```powershell
codex plugin marketplace upgrade lovart-codex
codex plugin add lovart@lovart-codex
```

ZIP 来源改到新目录时，在下载并解压新版后执行：

```powershell
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
codex plugin marketplace add 'C:\新版解压位置\lovart-codex-plugin'
codex plugin add lovart@lovart-codex
```

随后新建对话；如果提示文件被占用，退出 Codex 后再更新。卸载插件不会删除用户环境变量中的密钥。
