# sTools 0.5.0 · Everything SDK 搜索

本版 Windows 主搜索默认使用 Everything 官方 SDK 提供的 **IPC v2 接口**。用户表达式以 UTF-16 消息发送给正在运行的 Everything，由它执行索引查询；sTools 显示结果、分类和快捷键操作。没有复制 Everything 的索引引擎，也没有把 SDK 当成独立索引引擎。

## 已对齐

- 原样传递查询：英文双引号、空格 AND、`|` OR、`!` NOT、`<…>` 分组、`*` / `?`、`ext:`、`size:`、`dm:`、`regex:`。具体语法和结果由已安装的 Everything 版本决定。
- 名称、路径、大小和修改时间的升降序；区分大小写、全字匹配、匹配完整路径。这些选项只随本次查询发送，不修改 Everything 窗口的设置。
- 主搜索每页 100 项，支持继续加载。首次取得各分类的首页和总数，切换类别复用结果，不再因切换而重新查询或闪空。
- 检查已加载结果的有序路径指纹。索引变化使分页失效时从首页重置，避免沿用旧偏移产生重复、漏项。活动搜索约每 2 秒检查变化；实际可见延迟还取决于 Everything 的索引更新。
- 查询可取消、有超时和响应大小限制，失败显示重试、搜索设置和工具设置入口。查询内容不会进入 shell 命令。
- 普通用户权限的 SDK 桥接程序随 sTools 打包，主搜索无需 `es.exe`。已有内置索引仍可手动选择；SDK 模式不启动 sTools 自研索引工作线程。

## 分类与 Everything 的差异

“全部”中的本机文件结果保留 Everything 的顺序。“应用”分类使用 `exe`、`lnk`、`appref-ms`；“文件”分类排除这些程序条目；“文件夹”只显示目录。应用、插件和系统指令还会合并 sTools 自身的数据，因此整个启动器列表并不等同于 Everything 的文件列表。

每个分类是原始表达式外加分组后的类型约束，拥有独立查询结果；四类查询不是 Everything 的原子快照。后台变化通过指纹校验与版本重置处理。

本轮尚未复刻 Everything 的所有界面功能，例如自定义过滤器编辑器、书签管理、文件属性列、预览、运行次数排序、批量文件操作及完整 1.5 属性体系。不会同步 Everything 窗口当前的临时过滤器或搜索开关。目标是逐步对齐搜索能力和行为。

## 依赖与范围

需要本机 Everything 1.4.1 或更新版本，在与 sTools 相同的用户会话中运行。找到已配置的程序后以 `-startup` 在后台启动；如需指定路径或命名实例，使用“本地工具设置”。索引服务本身不提供桌面 SDK 查询窗口，需要 Everything 用户进程。

**搜索范围、排除规则、隐藏/系统文件、网络目录等由 Everything 的索引设置决定。** sTools 内置引擎的排除目录不作用于 SDK 模式。SDK 模式不会重建或修改 Everything 数据库；“刷新连接与结果”只清理 sTools 缓存。高级查询（例如内容查询）的成本和支持情况由 Everything 决定。

现有内置搜索配置、数据库及 sToolsSearch 服务保留以便切回。SDK 模式不发送自研索引请求；服务仍可能处于等待连接状态。本版安装器不安装或更新该服务。

## 开发验证

```powershell
pnpm build:search-native
pnpm test -- tests/main/everythingSDK.test.ts
$env:STOOLS_EVERYTHING_TEST_EXE='D:\soft\daily\Everything\Everything.exe'
$env:STOOLS_ES_TEST_EXE='D:\soft\daily\Everything\es.exe'
node tests/native/sdk-integration.cjs
pnpm test:e2e
```

真实 SDK 测试启动独立命名 Everything 实例，只索引临时夹具，不连接用户真实索引。官方 ES 仅作为测试对照工具。E2E 从源码 Electron 启动，隔离应用数据，测试环境禁止连接未命名的 Everything 实例。测试生成的路径只用于断言，不启动夹具中的程序。

SDK IPC 协议来源：[voidtools SDK](https://www.voidtools.com/support/everything/sdk/)、[IPC 文档](https://www.voidtools.com/support/everything/sdk/ipc/)、[命名实例窗口类说明](https://www.voidtools.com/forum/viewtopic.php?t=5575)。参考官方 `Everything-SDK.zip` 中的 `ipc/everything_ipc.h`，下载于 2026-10-15，SHA256：`F5716D9513CCE6B462B5170A0A2E7E081E191D9BCAC6774F5DECC061497DF443`。本项目实现协议桥接，没有分发或修改 Everything 引擎二进制。
