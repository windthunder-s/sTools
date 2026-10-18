# 本地工具接入

sTools 0.5.0 随软件加载的“本地工具”模块。搜索以下指令即可使用，也可以在“快捷键管理 → 浏览全部功能”中为每条指令单独绑定全局快捷键。

| 指令 | 功能 |
| --- | --- |
| Everything 搜索 / 文件搜索 / 文件夹搜索 | 在 sTools 内搜索文件名；空格分词，支持全部、文件、文件夹筛选 |
| Snipaste 截图 | 直接进入 Snipaste 选区和标注界面 |
| Snipaste 贴图 | 将剪贴板内容作为 Snipaste 贴图显示 |
| 本地工具设置 | 检测和修改 Everything / Snipaste 的路径 |

文件结果：↑/↓ 选择，Enter 打开，Ctrl+Enter 定位，Ctrl+Shift+C 复制路径；也可以使用每行按钮。每次最多显示 100 项，输入更多关键词缩小范围。该面板与主搜索使用同一 SDK 协议，支持 Everything 原生语法。需要分页及排序时请使用主搜索。

## 本机依赖

工具本体使用官方独立程序，不嵌入第三方二进制到 sTools 的分发包。

- Everything 1.4.1.1032 x64。Everything 负责本机索引，sTools 自带 SDK IPC 桥接程序查询；ES 已不是运行依赖，仅保留兼容代码和测试对照工具；不会开启 HTTP 服务或上传文件信息。
- Snipaste 2.11.3 x64。调用普通版已有的 `snip` 和 `paste` 命令；快捷键由 sTools 统一管理。
- 建议安装在 `D:\soft\daily\Everything` 和 `D:\soft\daily\Snipaste`，工具设置也支持手动路径及常见安装位置。已有路径失效时会提示，不会悄悄切换另一安装。
- Everything 必须已有可用索引。可使用 Everything 索引服务，也可以在其选项中配置文件夹索引。索引服务的安装是单独的部署步骤，sTools 本身不会自动安装服务或请求管理员权限。
- Snipaste 首次调用先启动进程并等待窗口消息循环，再隐藏 sTools、发出截图/贴图命令。命令发送成功不代表用户已经完成截图。
- 保留原有系统截图功能；新的 Snipaste 功能有独立指令。不会修改 Snipaste 的原生快捷键，也不会自动覆盖用户已有的 sTools 快捷键。

官方资料：[Everything 下载](https://www.voidtools.com/downloads/)、[ES 接口](https://www.voidtools.com/support/everything/command_line_interface/)、[Snipaste 下载](https://www.snipaste.com/)、[Snipaste 命令行](https://docs.snipaste.com/command-line-options)。

本次已下载文件：

| 文件 | 校验值 |
| --- | --- |
| Everything-1.4.1.1032.x64.zip | SHA256 `698DF475EC44E638F66F1B6A32D28FEA613CEC78D3B6310E6ABE53431EEB940C`，与官方校验表一致 |
| ES-1.1.0.38.x64.zip | SHA256 `5E0C70CBF4F694080C34AA7C6C745E606C16FE76A4B5423B93EBF9DC34274C99`，记录本次官方下载内容 |
| Snipaste-2.11.3-x64.zip | SHA1 `850BD133114A6B24156D19E41A06F057555B21B5`，与官方校验表一致；SHA256 `CBF572E18A79C93F9A573BBCCAB2ED8566141759A0C656C768932F0FEDF94189` |

## 验证

历史 ES 适配器及 Snipaste 单元测试覆盖：命令参数隔离、Unicode 搜索、结果数限制、文件夹筛选、查询取消、索引不可用、无效路径、Snipaste 冷启动顺序、重复请求和错误恢复。

源码 Electron E2E 覆盖：随包指令、全局快捷键注册、搜索界面、HTML 文件名转义、键盘定位、路径错误。真实 Everything 测试通过以下两个环境变量提供官方程序，在临时目录启动独立命名实例，仅索引测试文件，不接触真实用户数据和默认 Everything 实例：

```powershell
$env:STOOLS_EVERYTHING_TEST_EXE = '路径\Everything.exe'
$env:STOOLS_ES_TEST_EXE = '路径\es.exe'
pnpm test:e2e
```

未提供这些变量时，真实 Everything 用例跳过，其他用例正常执行。Snipaste 的进程顺序和命令参数使用隔离适配器验证，实际桌面选区操作仍需部署后验证。

自带截图、录屏和 GIF 功能见 [截图工具说明](docs/CAPTURE-TOOLS.md)，不需要 Snipaste。
