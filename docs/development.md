# 开发、测试与发布

Node.js 24+，Python 3.10+。源码位于仓库根目录，`plugin-build/lovart` 是供 Codex 安装的同步产物，入口加载 `dist/server.mjs`。

```sh
npm ci --ignore-scripts
npm run build:plugin
npm test
python test/agent_skill.test.py -v
python -m unittest discover -s test -p '*_test.py' -v
```

Windows PowerShell 可使用 `npm.cmd`。浏览器测试使用本机 Chrome，仅提交临时假密钥；POSIX 权限测试在 macOS 执行，Windows 会跳过。CI 分别运行 Windows 和 macOS 测试，macOS CI 通过不等于已人工验证每个 Mac 上的 Codex 桌面体验。

## 网页密钥配置

`lovart_configure_credentials` 无需密钥和项目即可返回临时 `127.0.0.1` 链接。配置服务只监听本机，检查会话 token、Host 和 Origin，15 分钟过期，成功保存后关闭。密钥不出现在工具参数、工具响应、命令行参数或聊天里。

Windows 使用隐藏的本机 writer，通过 stdin 接收两个字段并写入用户环境变量 `LOVART_ACCESS_KEY`、`LOVART_SECRET_KEY`。macOS 将两个字段原子替换到 `~/Library/Application Support/Lovart/credentials/keys.json`，目录权限 0700、文件权限 0600；它是本机配置文件，不是 Keychain 条目。

每次 Lovart 调用前重新读取保存值。macOS 尚无配置文件时保留进程环境变量；文件损坏或权限不正确时返回重新配置提示，不悄悄回退到旧密钥。v0.2.0 的原生 helper 源码和测试保留用于历史兼容维护，网页配置不调用旧弹窗。

Linux 仍使用进程环境变量，不提供网页配置。可选配置有 `LOVART_PYTHON`、`LOVART_OUTPUT_DIR`、`LOVART_CARD_STATE_DIR` 和 `LOVART_SKILL_SCRIPT`。

## 发布

更新包版本和插件 manifest，构建并同步 `plugin-build/lovart` 后，运行扫描与安装包测试：

```sh
python scripts/release_package.py scan
python scripts/release_package.py build --platform windows --version 0.3.0 --output-dir dist/release --dependency-source node_modules
python scripts/release_package.py build --platform macos --version 0.3.0 --output-dir dist/release --dependency-source node_modules
```

GitHub tag `v0.3.0` 触发双平台构建，发布 ZIP 及 SHA-256 文件。发布包只包含所需运行文件和文档，不包含本地数据库、生成结果、密钥或测试运行记录。官方 Python 客户端保留原有来源和许可。
