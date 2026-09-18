# macOS 安装与更新

完整图文指南见 [README](../README.md)。适用于 Apple Silicon 和 Intel Mac，需要支持插件的 Codex、Node.js 24+ 和 Python 3.10+（可使用 Codex 自带 Python）。

## 安装

在终端执行：

```sh
codex plugin marketplace add xiongrubing335100-beep/lovart-codex-plugin
codex plugin add lovart@lovart-codex
```

如使用 [Releases](https://github.com/xiongrubing335100-beep/lovart-codex-plugin/releases) 的 macOS ZIP，解压后改用目录作为来源：

```sh
codex plugin marketplace add '/Users/你的用户名/你的解压位置/lovart-codex-plugin'
codex plugin add lovart@lovart-codex
```

新建 Codex 对话，说「配置lovart的密钥」，打开返回的网页，粘贴 AK、SK 并保存。支持 ⌘V、右键粘贴与显示/隐藏。保存后下次调用自动读取，无需重启。

## 从旧版更新

Git 来源：

```sh
codex plugin marketplace upgrade lovart-codex
codex plugin add lovart@lovart-codex
```

ZIP 来源改到新目录时，在下载并解压新版后执行：

```sh
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
codex plugin marketplace add '/Users/你的用户名/新版解压位置/lovart-codex-plugin'
codex plugin add lovart@lovart-codex
```

更新后新建对话，必要时重启 Codex。v0.2.0 的 Keychain 配置会保留，但新网页流程使用本机文件保存，需要重新填写一次。

本版密钥位置：`~/Library/Application Support/Lovart/credentials/keys.json`。只有当前用户可以访问对应私有目录和文件；该文件不在插件缓存中，更新或卸载插件不会自动删除它。
