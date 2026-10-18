# 上游来源

sTools 0.4.2 基于 ZTools 的源码修改，直接沿用其 Electron 主进程、Vue 3 前端、设置插件、插件运行机制与原生模块。

- 仓库：https://github.com/ZToolsCenter/ZTools
- 标签：v3.2.0
- 提交：7c604516b01c153044d305d72600383ae0bc048f
- 原始许可证：MIT，见根目录 LICENSE；版权声明完整保留。
- 原项目说明：README.upstream.md、README_CN.md。

本地改动：产品标识与图标、独立的 .stools 数据目录、关闭上游应用更新通道、默认 Ctrl+Alt+Space、以快捷键管理为设置首页、快捷键页直达全部功能，以及独立的来源说明。

保留 window.ztools / uTools 兼容接口命名和插件格式；这些是插件调用契约，不作批量改名。产品接入 ZTools 公开插件目录、下载、说明和版本查询接口，始终匿名访问。上游账户、同步、社区评论、通知、心跳和官方 AI 入口仍关闭，宿主拒绝这些 API 调用。插件各自的许可与运行要求仍以对应插件为准。

旧 C#/WPF 0.1.0 的源码、测试和安装包保存在 legacy/wpf-0.1.0，不纳入新版构建。

0.3.0 新增由 sTools 自行实现的本地文件索引：Node 工作线程、内置 SQLite FTS5、目录变动监听、持久缓存、搜索范围与排除设置。没有复制或打包 Everything 的搜索引擎，Everything 保留为可选外部接入。

0.4.0 新增自研 Windows MFT/USN 元数据辅助程序、日志游标及恢复机制、查询快照分页和搜索语法。只使用公开 Windows API，没有取得或复制 Everything 引擎源码。0.4.1 经用户明确授权安装服务，完成真实 MFT/USN 隔离目录验证并修复服务启动和根记录缺失问题，详见 docs/FAST-SEARCH.md。

0.4.2 修复真实卷增量更新中的 SQLite 递归查询计划，并跳过无路径变化的重复日志。C/D/E 安装版自动同步与隔离目录重启恢复已验证，测试记录见 TESTING.md。
