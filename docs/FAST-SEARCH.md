# sTools 0.4.2 搜索优化（历史说明）

0.5.0 Windows 默认主搜索已改用 Everything SDK IPC；当前行为见 [SDK 搜索说明](SDK-SEARCH.md)。下文记录保留为备用引擎的实现与历史验收。

本轮完成查询分页、分类快照缓存和搜索语法，并加入自研 NTFS MFT/USN 索引通道。没有复制或嵌入 Everything 引擎。

## 直接可用的变化

- 内置索引每次输入只生成一份有序匹配快照，全部、应用、文件、文件夹共用快照。
- 每页 100 条，可“加载更多”浏览完整匹配集合；切换分类保留已加载页面。
- 索引变化会使旧分页版本失效，并从首页重新显示，避免继续使用过期偏移导致漏项或重复。
- 支持普通关键词 AND、英文双引号短语、`*` / `?` 通配符、`ext:txt;pdf`、`!排除词`、`path:"C:\目录"`。通配符作用于整个名称；普通关键词匹配名称中的任意位置。
- `%`、`_`、单引号作为字面字符处理。SQL 参数单独绑定。
- 子树删除使用路径范围索引，避免每次变更都全表 LIKE 扫描。

暂未实现 Everything 的完整语法、正则、大小/日期过滤和文件内容检索。外部 Everything 适配器仍遵循原来的前 100 项接口。

## NTFS 快速通道

`src/native/search/NtfsReader.cs` 使用 Windows 公开的 `FSCTL_ENUM_USN_DATA` 枚举 MFT，使用 `FSCTL_READ_USN_JOURNAL` 跟踪创建、删除、改名、硬链接及重解析点变动。文件参考号和日志游标通过十进制字符串传输，保留 64 位精度。

工作线程维护 NTFS 父子图及持久日志游标，只将搜索范围内、未排除的可解析路径发布到搜索表。图保存卷级名称/父子元数据以解析跨目录移动，范围和排除项限制搜索结果，不代表原始图不含范围外的名称。它不读取文件内容。目录联接和符号链接不沿路径递归。

首次成功读取 MFT 后，常规更新每 2 秒读取新日志；重启续读已保存游标。日志丢失、日志标识变化、未完成的更新、设置改变及大量积压时重建。快照导入和变更投影按批次让出工作线程，界面主线程不承担磁盘扫描。

局限：当前通过 Windows USN 枚举接口获取每个文件参考号返回的名称，没有实现硬链接全部别名枚举；NTFS 快速模式可能不显示同一文件的其他硬链接名称。非 NTFS、网络目录、无读取权限、未启用日志及不支持的记录版本使用普通目录扫描。需要检索所有硬链接名称时应使用普通扫描/Everything；后续需增加别名枚举专项验证。

## 已授权安装的只读索引服务

2026-10-15，用户明确回复“允许安装并验证快速索引”，此前因缺少授权导致的安装阻碍已解除。服务已安装且运行，普通用户客户端经服务成功读取 C、D、E 盘的日志元数据。服务启动不再设置不存在的控制台编码；路径解析能够处理 MFT 枚举省略根目录记录的真实情况，并通过投影版本变化让旧索引自动重建。

已安装配置：

- 服务名：`sToolsSearch`；显示名：`sTools File Index`。
- 账户：`LocalSystem`；启动方式：自动。
- 程序：`C:\Program Files\sTools Search\stools-ntfs.exe --service`。目录只允许管理员和 SYSTEM 写入，普通用户只读和执行。
- 注册表：`HKLM\SOFTWARE\sTools\Search\OwnerSid`，保存安装所属用户 SID。
- 通信：仅本机命名管道 `sTools.Search.<SID>`，ACL 仅授予安装用户和 SYSTEM；不建立 TCP/HTTP 监听。
- 协议只接受固定 NTFS 磁盘字母及 `probe` / `snapshot` / `changes` 元数据读取，不能接受 shell 命令或任意写文件指令。不创建、删除或重建系统 USN 日志。
- sTools 界面维持普通用户权限。安装/更新/停用服务由独立辅助程序请求 Windows UAC；应用安装器不自动安装这个服务。
- “搜索设置”提供启用/停用入口。服务卸载删除服务注册、专用注册表项和专用辅助程序，保留搜索数据库和用户文件。

真实 E 盘隔离测试通过 10 项检查：MFT 快照、Unicode 路径和排除项、新增及应用分类、文件改名、目录改名与后代路径更新、移入/移出排除目录、删除、无变化游标轮询、索引进程重启续读与子树删除；文件内容校验保持不变。未通过重新启动 Windows 验证开机启动，自动启动配置已核对。报告见 artifacts/native-real-verification.json。

## 0.4.2 本机验收（2026-10-15）

- 用户明确授权安装和验证后，sToolsSearch 已安装并运行：LocalSystem、自动启动、程序目录仅管理员和 SYSTEM 可写。本机普通权限客户端成功访问 C、D、E 的只读元数据。
- 已部署 0.4.2；安装器退出码 0，主程序、app.asar、4 个搜索资源、73 个内置插件文件以及服务辅助程序的 SHA256 与构建一致。报告：artifacts/native-deployment.json。
- C、D、E 的 MFT 投影和 USN 检查点均已就绪（dirty=0），使用 builtin 引擎。检查时可检索条目分别为 79997、275971、24408，共 380376 项；计数会随磁盘变化。原始图另包含排除范围外的父子元数据，不等同于可见结果数。报告：artifacts/native-installed-health.json。
- 真实安装版由后台定时器自动同步三个盘的受控文件：新增 1013 ms、目录改名及后代路径更新 2041 ms、删除 2038 ms；没有手动触发刷新。所有测试目录已清理。报告：artifacts/native-installed-verification.json。
- 隔离真实 E 盘另通过 10 项检查，包括 Unicode、排除项、创建、改名、移动、删除、无变化轮询与索引进程重启续读；未重新启动 Windows，自动启动仅核对服务配置。报告：artifacts/native-real-verification.json。
- 最终相关单元测试 19 项、源码 Electron 专项 E2E 16 项、C# 解析器检查 4 项通过；类型检查与生产构建通过。日志：artifacts/native-unit-final.log、native-e2e-final.log、native-parser.log、native-build-final.log。

实机发现并修复的三类问题：服务没有控制台而在启动时崩溃；MFT 枚举可能缺少根目录记录而无法还原路径；递归目录查询被 SQLite 排成整卷扫描，导致增量更新积压。路径投影加入版本号让旧数据自动修复，递归查询使用文件标识和父目录完整索引，并跳过名称、父目录和属性都没变的累计 USN 记录，避免无效分页重置。

增量查询基准：实际 D 盘 291292 个图节点，对同一个文件的后代查询各运行 5 次，中位耗时由 147.90 ms 降至 0.0061 ms；新计划使用 (volume, parent) 索引。这只代表已缓存数据库中的这一条内部查询，不是整体搜索、全盘建索引或 Everything 对比。报告及复现脚本：artifacts/native-delta-benchmark.json、native-delta-benchmark.cjs。

0.4.1 的安装版实测曾出现新增约 36 秒、改名约 43 秒、删除超时，保留在 artifacts/native-installed-slow-041.json；0.4.2 使用原先 15 秒超时标准通过。安装与中途失败记录均保留，最终部署以 native-deployment.json 为准。分发包 release/sTools-0.4.2-win-x64-setup.exe，校验文件 release/SHA256SUMS-0.4.2.txt。

## 0.4.0 历史验证

- 16 项相关单元测试通过：真实临时目录扫描、查询语法、完整分页、版本失效、路径边界、MFT 图投影及 USN 回放。
- 编译后的 C# 解析器 4 项检查通过：Unicode/64 位标识、未知记录版本、错误偏移、截断缓冲。
- 源码 Electron 全量 E2E 31 项通过，使用隔离用户数据；测试环境禁止服务安装和原始卷索引。
- 最终修改后的 E2E 复测结果见 `artifacts/fast-e2e-verified.log`。
- 查询基准见 `artifacts/fast-benchmark.json`：10 万条合成索引，5 次独立索引实例的首屏耗时中位数；后续分页耗时只代表查询核心，不含 IPC、渲染和磁盘建索引。没有做 Everything 同机速度对比。

| 查询 | 0.3.0 首屏 | 0.4.0 首屏 | 0.4.0 后续页 |
| --- | ---: | ---: | ---: |
| report_报告_001（1000 个匹配） | 4.28 ms | 2.13 ms | 0.07 ms |
| 报告（10 万个匹配） | 62.16 ms | 69.41 ms | 0.08 ms |
| report（10 万个匹配） | 114.03 ms | 79.69 ms | 0.07 ms |

新版同时生成完整结果顺序和分类总数，宽泛中文查询首屏仍有额外开销，不能宣称所有查询都更快。

Windows 构建运行 `pnpm build:search-native`，使用 Windows 自带的 .NET Framework 4 编译器生成辅助程序；`pnpm build` 和 `pnpm test:e2e` 已包含该步骤。

公开接口参考：[MFT 枚举](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_enum_usn_data)、[USN 日志读取](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_read_usn_journal)、[USN_RECORD_V2](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v2)。

复测过程记录：带追踪的复测出现 Electron 退出清理超时，且桌面自动粘贴曾干扰分页用例。已隔离 E2E 真实剪贴板，并修复无变化索引复核及迟到状态轮询导致分页重置的问题。独立退出诊断正常；最终搜索及相关回归关闭 trace 运行，保留原功能断言。历史失败日志仍保留在 artifacts/fast-e2e-final.log 和 artifacts/fast-e2e-isolated.log。


0.4.0 最终验证：16 项专项 Electron E2E 全部通过（关闭 trace，artifacts/fast-e2e-verified.log），16 项相关单元测试和 4 项 C# 解析器检查通过。首轮全量 31 项曾全部通过，复测中的退出追踪超时与分页缺陷及修复过程均保留记录。

历史 0.4.0 分发记录（已由 0.4.2 替代）：当时本机已覆盖升级，安装器退出码 0；文件版本 0.4.0，主 EXE、app.asar、4 个搜索资源以及 73 个内置插件文件与构建一致。4 个 sTools 进程已运行；内置索引可读取，检查时共 469896 项。当时独立 sToolsSearch 服务未安装、等待明确授权，未进行真实卷 MFT/USN 加速实测；该状态现已解除，见上方 0.4.2 验收。报告 artifacts/fast-deployment.json、artifacts/fast-installed-index.json，校验文件 release/SHA256SUMS-0.4.0.txt。
