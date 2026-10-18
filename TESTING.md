# sTools 0.6.0 截图功能审查与统一入口（2026-10-15）

- 先依据 Snipaste 官方操作说明和用户参考图审查功能，形成 `docs/CAPTURE-REVIEW.md`。快速入口默认直接截图，可显式选择默认模式；统一选区支持截图、录屏、长截图、GIF 切换，保留区域和标注。首次没有已有截图绑定时尝试 F1，复用中央冲突检查，已有绑定和用户移除决定均保留。
- 修复闭环笔迹消失、单击不成点、当前标注无法改色/粗细、录屏取消后不可重试、迟到媒体未释放、小贴图按钮越界等问题。新增手动垂直长截图，要求稳定且唯一的重叠匹配，保留原始像素。实现候选大小检查，达到输出上限前保留已验证图像；完成、保存和切换取消均有重入保护。
- 基线 10 项实际审查为 4 通过、6 失败：`artifacts/capture-audit-baseline.log`。其中 Enter 的失败属于测试在窗口关闭后仍发送 keyup，修正为真实 keyDown 和窗口关闭结果校验；未将其误记为应用复制故障。预设六色、自定义颜色和实际笔宽基线已通过。
- 第一轮修复后 32 项源码 Electron E2E 全部通过：`artifacts/capture-research-e2e.log`。覆盖实际 RGB、实际线宽、形状/画笔/荧光笔/马赛克/文字/橡皮擦、撤销重做、闭环和画点、中文组合输入、复制保存/贴图、准备与倒计时取消、媒体失败重试、真实 MP4/GIF 录制和长图拼接。
- 中央快捷键回归 4 项和设置跳转 1 项通过：`artifacts/capture-quick-e2e.log`。该轮快速入口 4 项在 Escape keyup 阶段遇到关闭窗口的测试竞态，已改为向真实 editor WebContents 发送 keyDown，保留窗口消失断言。
- 最终 25 项源码回归全部通过：`artifacts/capture-final-e2e.log`。含修正后的快速入口 5 项、模式与长图 8 项、加载切换竞态 5 项、原有截图/真实录屏 7 项。新增验证双击完成只提交一次、完成 IPC 幂等、64 MiB 编码超限仍可保存原图、加载期间取消后不复活窗口、加载失败恢复同一选区。三轮合计 **48 个不同的相关 E2E 用例通过**，未声称重跑全部上游用例。
- 快速入口、F1 初始化、快捷键冲突等相关单元测试 **42 项通过**：`artifacts/capture-quick-unit.log`。最终产品中的真实拼接模块由 `node --test tests/capture/vertical-stitch.test.mjs` 验证 **26 项通过**：`artifacts/capture-stitch-unit.log`，包含上滚、重复、固定栏、动画单像素、低纹理、无重叠、物理图像重建与全高清输入。
- 完整类型检查、设置插件、原生搜索组件及 Electron 构建通过：`artifacts/build-0.6.0.log`。先进行源码 E2E，再打包；所有用例使用隔离临时配置和自有屏幕画面。复制测试使用内存记录，不覆盖真实用户剪贴板。
- 实际界面和输出保存在 `artifacts/capture-0.6.0/`：`capture-home.png` 来自真实插件 WebContentsView 当前可见区域，`capture-workflow.png` 来自真实截图窗口，`verified-long.png` 为逐段位图核验的原像素长图；没有拼接界面截图。真实长图三段接缝逐像素比对，停留及上滚不追加。
- 本机环境为单显示器 2560 × 1440、125% 缩放。实际录屏输出为无声，音频仅验证权限/取消逻辑，未验证所有音频硬件、多显示器或长时间录制。快捷键测试调用真实系统注册回调，不等同于物理键盘硬件测试。长图为手动垂直滚动，未实现自动滚动、固定栏自动裁切、长图标注、OCR、窗口吸附或完整 QQ/Snipaste 功能复刻。

- 已完成本机 0.5.4 → 0.6.0 覆盖升级，安装器退出码 0，应用已启动。EXE、app.asar、插件 preload、84 个内置插件文件、16 个截图资源与 6 个搜索资源逐项 SHA256 一致。启动日志确认原有 `F1 → capture-tools/sTools 截图` 绑定成功注册，主呼出键 `Alt+Space` 保留；这台机器没有将已有 F1 重定向到新增快速入口。报告 `artifacts/capture-research-deployment.json`；安装包 `release/sTools-0.6.0-win-x64-setup.exe`（94,935,310 字节），SHA256 `996148BF4095658CD469A6F9100A44A6291B0DCCD4B7F6375BC05EBACE8C169C`。

---

# sTools 0.5.4 截图参考样式对齐（2026-10-15）

- 按用户提供的参考图调整为浅色单行工具栏、灰色图标与细分隔线、蓝色选区和黑底尺寸标签；主工具栏顺序为形状、箭头、画笔、荧光笔、马赛克、文字、橡皮擦、撤销、重做、取消、贴图、保存、复制。形状与颜色/粗细在独立面板显示，保持主行紧凑。
- 新增荧光笔及橡皮擦。标注在独立图层重放，擦除仅影响标注，保留原始截图并支持撤销和重做；全屏入口移到形状选项，并支持 Ctrl+A。
- 类型检查、设置插件、原生搜索组件及 Electron 生产构建通过：`artifacts/build-0.5.4.log`。
- 最终 7 项源码 Electron E2E 通过：`artifacts/capture-style-e2e-final.log`。覆盖实际 PNG 保存、箭头撤销/重做、贴图、无声 MP4/GIF 导出、权限边界、八点缩放、边缘布局、文字输入、保存取消、双击复制、连续快捷键注册回调、参考图按钮顺序与单行排列、形状切换、荧光笔及擦除后原图逐像素一致。
- 最终尺寸调整前的 7 项同样通过，日志 `artifacts/capture-style-e2e.log`；最终以 final 日志为准。用例从源码 Electron 启动，独立临时配置和屏幕夹具，不修改真实用户数据或剪贴板。快捷键用例调用真实系统注册回调，不等于物理键盘测试。
- 真实截图窗口的可见区域证据：`artifacts/capture-reference-0.5.4.png`。画面内选区为 237 × 61 实际像素；本机为 2560 × 1440、125% 缩放。截图由 Playwright 直接截取，没有拼接或重绘。未扩展到多显示器、音频硬件、长时间录屏或完整上游用例。

- 0.5.4 本机覆盖升级完成：0.5.3 → 0.5.4，安装器退出码 0；EXE、app.asar、插件 preload、84 个内置插件文件、12 个截图资源及 6 个搜索资源逐项 SHA256 相同，应用已重新启动。安装器 `release/sTools-0.5.4-win-x64-setup.exe`，报告 `artifacts/capture-style-deployment.json`，SHA256 `C36D9C62BF43391B8AB7F9CE5D71C34440C9327D588E987AF6D70F0F50F479A3`。

---

# sTools 0.5.3 截图快捷键、布局与冲突保护（2026-10-15）

- 修复 `mainHide` 截图指令被同指令单例重入判断跳过；已有选区时再次触发聚焦原会话，避免错误提示弹回主窗口遮挡截图。
- 截图工具栏改为选区旁的紧凑图标，增加八点缩放、就地文字输入、双击复制、右键退出工具、指针取消恢复及屏幕边缘避让；布局参考 Snipaste，未复制其程序或资源。
- 快捷键后端统一检查主呼出键、全局/应用内、内置操作、已知系统保留键；识别别名与修饰键顺序，异步注册加占用锁，同键重定向要求明确编辑。通用设置及原快捷键管理共用安全保存逻辑；主呼出键先注册新键，成功后才释放旧键。
- 类型检查与生产构建通过：`artifacts/build-0.5.3-final.log`。
- 39 项相关单元测试通过：`artifacts/shortcut-capture-unit.log`。覆盖外部占用、原生优化检查、同时注册、跨范围和内置冲突、同键编辑失败恢复、主呼出键注册抛错保留、持久化事务与选区几何。
- 首轮 9 项源码 Electron E2E 全部通过：`artifacts/shortcut-capture-e2e.log`，包括实际 PNG 保存、标注撤销/重做、贴图、无声 MP4/GIF、权限边界、连续截图、布局、快捷键编辑和重启持久化。
- 最终布局和连续截图复测通过；追加后端冲突用例发现插件 preload 丢失显式编辑参数，修复后实际 IPC 用例通过：`artifacts/shortcut-bridge-e2e.log`。随后完整快捷键设置与原插件 Esc 流程 5 项通过：`artifacts/shortcut-bridge-regression.log`。失败及修复过程保留在 `artifacts/shortcut-capture-e2e-final.log`；本轮累计 11 个不同的相关 E2E 用例通过。
- 使用源码 Electron 和隔离临时数据，实际捕获自建屏幕夹具。快捷键启动测试调用操作系统真实注册的回调，连续完成/取消四轮，另验证已有选区期间重复触发；这不等同于物理键盘硬件测试。外部软件占用的失败分支由可控系统注册桩验证，低级钩子及双击修饰键不保证检测。
- 布局实测为本机 2560 × 1440、125% 缩放；未扩展验证多屏、麦克风/系统音频、长录制和完整上游用例。真实截图证据：`artifacts/capture-editor-0.5.3.png`。

- 0.5.3 分发完成：本机 0.5.2 → 0.5.3，安装器退出码 0。EXE、app.asar、插件 preload、84 个内置插件文件、12 个截图资源及 6 个搜索资源逐项哈希一致；应用已重新启动。安装包 `release/sTools-0.5.3-win-x64-setup.exe`，部署报告 `artifacts/shortcut-capture-deployment.json`，SHA256 `571FF2AD89D9BAB9BD8F3FC4C1B7BCDB6665A9125290AABC3737CE589CDA0FD1`。

---

# sTools 0.5.2 主程序呼出快捷键验证（2026-10-15）

- 「插件快捷键」顶部新增「快速打开 sTools」，显示当前呼出键，可录制修改或恢复默认 Ctrl+Alt+Space；保存到既有通用设置的 hotkey 字段，不写入插件绑定列表。
- 类型检查与生产构建通过：`artifacts/build-0.5.2.log`。
- 22 项相关单元测试通过：`artifacts/launcher-shortcut-unit.log`。含 8 项新测试：全局/应用内冲突、合并保留通用设置、配置过期、注册异常和持久化失败恢复原键等。
- 3 项源码 Electron E2E 通过：`artifacts/launcher-shortcut-e2e.log`。包括此前插件快捷键流程，以及主呼出键修改、实际系统注册、旧键释放、从隐藏状态调用真实注册回调唤起主窗口、冲突保护、恢复默认选项、完整重启后注册生效和通用设置同步。
- E2E 使用隔离数据与旧数据目录，测试组合键为 Ctrl+Alt+Shift+F7/F12；未修改用户安装版快捷键。窗口唤起验证调用了真正注册的回调，不等同于硬件键盘按键测试。恢复默认选项验证选择和取消，未抢占正在运行的安装版默认键。
- 实际设置 WebContentsView 的可见区域截图：`artifacts/launcher-shortcut-0.5.2.png`。未使用安装包跑 E2E。

---

# sTools 0.5.1 插件快捷键验证（2026-10-15）

- 左侧「功能与插件」和「插件市场」之间新增「插件快捷键」，并添加搜索指令和插件详情中的直达入口。按功能合并多个指令，显示已有全局/主搜索页快捷键，支持搜索、筛选、录制、保存、修改和移除。
- 类型检查、设置插件和主程序生产构建通过：`artifacts/build-0.5.1-final.log`。
- 16 项相关单元测试通过：`artifacts/plugin-shortcuts-unit-final.log`。覆盖历史别名归组、停用和内容型功能、平台筛选、组合键别名、主唤起键冲突、跨范围冲突、旧配置保护、注册及保存失败回滚。修复已有快捷键后端测试遗漏独立窗口管理器 mock 导致加载真实数据库的问题；最终测试隔离运行。
- 2 项新增源码 Electron E2E 通过：`artifacts/plugin-shortcuts-e2e-final.log`。在实际设置 WebContentsView 中验证入口位置、录制、真实 globalShortcut 注册、冲突、修改后旧键释放、重载后持久化、Esc 分层取消、移除、搜索、旧应用内绑定及详情跳转、应用内绑定保存。
- 另有 7 项原有源码 Electron 回归通过，覆盖旧快捷键管理、插件 Esc、插件列表/市场/安装与外部工具入口：`artifacts/plugin-shortcuts-e2e.log`。该日志中新增用例早期失败由合成键盘事件错误派发到 window 引起，改为实际 DOM 事件路径后在 final 日志通过；没有跳过或降低断言。
- E2E 使用独立临时数据根与旧数据目录，未使用安装包跑 E2E。真实插件视图截图保存在 `artifacts/plugin-shortcuts-overview-0.5.1.png`、`artifacts/plugin-shortcuts-editor-0.5.1.png`；等待正文及动画稳定后截取，不与宿主拼接。
- 构建完成后生成 NSIS 安装包并更新本机 0.5.0 → 0.5.1，安装器退出码 0；主程序、app.asar、83 个内置插件文件、12 个截图资源和 6 个搜索资源哈希与构建一致。报告：`artifacts/plugin-shortcuts-deployment.json`。安装包：`release/sTools-0.5.1-win-x64-setup.exe`，校验：`release/SHA256SUMS-0.5.1.txt`。
- 本轮没有重跑搜索索引及截图录屏的全部功能测试；此次修改范围为快捷键设置界面与录制交互。需要内容输入的功能显示使用前提，其高级快捷键仍可通过原「快捷键管理」配置。

---

# sTools 0.5.0 SDK 搜索与截图录屏验证（2026-10-15）

- 类型检查、原生搜索辅助程序、设置插件及 Electron 生产构建通过：`artifacts/build-0.5.0-verified.log`。
- 相关单元测试 8 个文件、58 项通过：`artifacts/sdk-capture-unit-verified-final.log`。包含查询取消、分类缓存、分页版本、索引增量、坐标边界、内置插件注册及开发插件同名保护。旧开发插件路径断言由固定 POSIX 路径改为当前平台的绝对路径；不改变实际路径逻辑。本轮未执行全部上游单元测试。
- 完整源码 Electron E2E 35 项通过：`artifacts/sdk-capture-e2e-verified.log`。独立临时配置、关闭 trace，实际 Everything 命名实例只索引夹具。覆盖插件市场、快捷键、主搜索、原生 SDK 语法/分类/235 条分页/设置/打开操作、截图和录屏。
- SDK 原生测试与官方 ES 对照 9 种查询（扩展名、通配符、引号、OR、NOT、正则、大小、日期、路径）一致；235 项按 100/100/35 分页无重复，匹配开关、大小排序及中途改名重置均通过。创建/改名/删除可见。报告 `artifacts/sdk-integration.json`；其中计时来自隔离文件夹索引，不能视为与 Everything 的性能对比。
- 在本机 2560 × 1440、125% 缩放下真实截图，400 × 300 DIP 选区保存为 500 × 375 PNG；验证箭头撤销/重做、保存、贴图、透明度、复制、Esc 取消和关闭后宿主仍可用。复制动作在测试中替换为内存记录，不改变用户剪贴板。
- 实际屏幕动画录制通过 MP4 与 GIF 导出、倒计时、暂停/继续和停止。独立 Chromium 解码 MP4 得到 800 × 450、2.356 秒，六个采样时间点有不同帧（`artifacts/video-decode-verification.json`）；GIF 解码确认多帧动画。界面与媒体证据在 `test-results/playwright`。
- 修复实测发现的全屏窗口被工作区裁剪导致的纵向比例偏差、Electron 41 空 mediaTypes 桌面录制权限误拒、同一路径再次保存及窗口权限清理。设置页与主程序共享内置插件名单，截图插件正确标为内置并提供功能快捷键按钮。
- 本轮实际捕获测试使用自建屏幕画面、单显示器及无声录制；未实测麦克风/系统音频设备组合、跨显示器硬件差异、30 分钟长录制或异常断电恢复。不包含滚动长截图、OCR、视频剪辑和完整 QQ/Snipaste 功能复刻。

失败与修复日志保留在 `artifacts/capture-*`、`artifacts/sdk-capture-e2e-full.log`。最终验证以上述 verified 日志为准。安装结果另见 `artifacts/sdk-capture-deployment.json`，安装包校验见 `release/SHA256SUMS-0.5.0.txt`。

---

# sTools 0.4.2 快速索引服务与真实磁盘验证

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

---

# sTools 0.4.0 搜索优化验证

- 类型检查通过，相关单元测试 16 项通过；实际 C# 元数据解析器 4 项检查通过。
- 源码 Electron 全量 E2E 31 项通过；最终复测见 artifacts/fast-e2e-verified.log。
- 新增分页完整性、分类缓存、搜索语法和错误恢复，原有插件、快捷键及外部 Everything 回归通过。
- 十万条合成索引查询基准见 artifacts/fast-benchmark.json；部分查询更快，宽泛中文首屏仍有额外开销，不代表与 Everything 同机对比。
- 自动审批拒绝持久化高权限服务安装，因此没有执行安装、未进行真实卷 MFT/USN 实测。已实现服务权限边界和普通扫描回退；模拟日志测试及解析器测试不替代真实服务验证。具体待审批配置与限制见 docs/FAST-SEARCH.md。
- 修改前备份：artifacts/before-fast-search-0.3.0。

---

# sTools 0.3.0 内置搜索验证记录

新增独立本地文件名/路径索引，默认免 Everything 运行；支持持久数据库、后台扫描、目录监听、范围和排除项设置，以及可选 Everything 接入。内置查询从完整索引分别返回各类别的前 100 项，前端复用这些结果，不从截断的全部结果推导分类。

- TypeScript 主进程与前端检查通过：artifacts/builtin-final.log。
- 相关单元测试 8 项通过：中文与特殊字符、路径、分类上限、增量新增/改名/删除、重启持久化、排除项、移除范围、目录联接循环与目录替换成文件。日志 artifacts/builtin-unit-final.log。
- 内置专项源码 Electron E2E 已验证禁用 Everything 后仍可搜索、阻断后续查询时分类仍能切换、真实目录通知与重启恢复、设置和键盘边界；另验证非主窗口不能查询索引或修改范围。
- 测试使用隔离文件和应用数据。首次用例把文件放在应用数据根目录里，被正确的自排除规则过滤，已改为相邻的独立目录。
- 预览：artifacts/previews/sTools-0.3.0-search.png、artifacts/previews/sTools-0.3.0-search-settings.png。
- 内置扫描为普通目录遍历；首次扫描需要时间，未完成时明确显示进度。只搜索文件名或路径，单分类显示前 100 项。没有进行百万级文件性能基准，不声称达到 Everything 的速度。

---

# sTools 0.2.5 搜索分类栏修复验证记录

分类栏移到结果滚动区外，避免 Windows 透明材质下滚动结果透到分类按钮下面。修改关键词、分类或展示模式时回到列表顶部；键盘选中项按实际滚动区边界定位。

- 先用鼠标滚动与透明材质用例复现 0.2.4 的重叠，日志 artifacts/layout-reproduce.log，截图 artifacts/previews/sTools-0.2.4-category-overlap.png。
- TypeScript 主进程/前端检查通过：artifacts/layout-check.log。
- 源码 Electron 主搜索专项 E2E：9 项全部通过，使用临时应用数据，包括真实 Everything 查询、分类、键盘、竞态、错误恢复、列表右键操作，以及新增聚合/列表模式的鼠标滚动和切换复位验证。
- 新增用例覆盖浅色 Mica 和深色 Acrylic 材质，检查分类与结果几何边界和命中区域；截图人工检查确认无重叠。日志 artifacts/layout-e2e.log。
- 修复后预览：artifacts/previews/sTools-0.2.5-categories.png。本轮未复跑全部上游单元测试或完整 E2E；下方保留历史结果。

---

# sTools 0.2.4 主搜索验证记录

主搜索框复用 Everything 适配器和本地工具配置，合并本机索引与原有应用/插件指令。提供全部、应用、插件、文件、文件夹、系统分类，Alt+1–6 切换、Enter 打开、Ctrl+Enter 定位和右键复制路径。

- 主进程只允许主窗口调用索引接口；每次查询读取插件命名空间中的最新设置，无需先打开插件页面。
- 220ms 输入防抖、查询取消和递增请求标记避免迟到结果覆盖；文件/文件夹/应用筛选在 Everything 中执行，每次最多 100 项。
- 文件通过系统关联打开，不拼接 shell 命令；成功打开后可加入最近使用。程序与快捷方式按扩展名分类，文件夹优先。
- 最终 TypeScript 主进程/前端检查通过：artifacts/search-typecheck-final.log。
- 4 个相关测试文件、22 项单元测试通过：artifacts/search-unit-final.log。
- 最终源码 Electron E2E 共 23 项全部通过：artifacts/search-e2e-release.log。补验发现启动时应用扫描会推迟注册键盘及插件事件，已改为先注册事件再扫描，并用延迟 8 秒的应用扫描验证即时分类快捷键。
- 新增 7 项 E2E 覆盖分类、Alt 快捷键、异步竞态、错误恢复/配置入口、列表模式/右键复制、真实 Everything 查询与打开/定位 IPC；另验证长结果列表选中项不会被吸顶分类栏遮挡，以及启动扫描未结束时仍可使用快捷键。
- 真实 Everything 使用命名隔离实例和临时目录，验证中文文档、文件夹及程序扩展名。打开/定位验证在系统 shell 边界记录调用，不实际运行测试 EXE 或打开外部文档。
- 所有应用数据均在临时目录；未执行外部市场插件。原有市场、快捷键、插件退出、登录占位及本地工具回归通过。
- 真实索引预览：artifacts/previews/sTools-0.2.4-search.png。

---

# sTools 0.2.3 插件管理与市场验证记录

本次实现：内置功能和外部插件统一展示、来源筛选、Everything/Snipaste 功能级快捷键入口，以及 ZTools 公开插件市场的浏览、搜索、安装、更新和离线目录缓存。上游账号、同步和社区接口继续关闭。

- 相关单元测试：7 个文件、57 项通过，覆盖匿名市场边界、内置保护、安装事务/回滚、升级流程和本地工具。
- 源码 Electron 回归：15 项通过，1 项因未提供 Everything 环境变量而跳过；该真实 Everything 中文文件/目录用例已在本轮之前的完整运行中通过（该次仅新卡片启动用例失败，随后已修复）。
- 最终专项 E2E：5 项通过，包含内置列表/筛选/详情保护、Snipaste 快捷键预选与 Everything 卡片启动、断网重试、受控市场插件完整安装/运行/卸载、真实市场目录搜索与缓存回退。
- 所有 E2E 使用临时数据目录与源码 Electron；未用安装包替代源码 E2E。
- 真实市场公开目录、下载地址和最新版本接口均已验证。另下载 Base64 1.0.0 ZIP，仅只读检查清单（8 个文件，name=base64），未安装或执行该第三方插件。
- 上述 ZIP 的 SHA256：ABB72572A33DE7018E2FC8FBA8A2B3E11ACA710A86E333BC9ED525F79BE81B09。
- 自动审批拒绝了未经核验的第三方插件执行测试；改用本机测试服务器提供的静态 HTML 插件验证真实下载、解包、注册和运行流程，不声称第三方插件已运行验证或全部兼容。
- 日志：artifacts/market-unit.log、artifacts/market-e2e.log、artifacts/market-e2e-targeted.log、artifacts/market-e2e-final.log。
- 截图：artifacts/previews/sTools-0.2.3-functions.png、artifacts/previews/sTools-0.2.3-market.png。

---

# sTools 0.2.2 本地工具验证记录

新增 Everything 内嵌文件搜索和 Snipaste 截图、贴图指令。

- 源码 Electron E2E：11 项通过，包括真实 Everything 1.4.1.1032 + ES 1.1.0.38 返回中文文件和文件夹、筛选和完整显示路径；所有应用数据和索引均隔离到临时目录。
- 相关单元测试：3 个文件、25 项通过，包括 7 项新接入测试、14 项离线服务边界和 4 项窗口启动行为检查。
- Snipaste 冷启动、等待就绪、隐藏宿主、发送命令和失败恢复经适配器测试；不将这些测试视为实际桌面选区验证。
- 日志：artifacts/local-tools-e2e-final.log、artifacts/local-tools-unit-final.log。
- 本次未运行全部上游单元测试。下方记录为历史版本验证结果。

---

# sTools 0.2.1 验证记录

本次范围：移除 ZTools 在线生态入口和宿主调用，保留本地插件；预留微信/手机号登录，所有本地功能免登录；搜索框默认图标改为大写 S。

- `pnpm test:e2e`：8 项全部通过，使用源码 Electron、临时数据目录和真实设置插件页面。
- 新增覆盖：旧市场/云账号/同步/官方 AI API 返回移除状态，历史市场路由回退，本地插件安装与运行，搜索页实际加载的头像资源与 S 图标一致，微信/手机号未接入提示和免登录返回。
- 旧云登录与同步 E2E 随产品功能移除，由本地产品契约测试替代；原用例保存在上游 Git 历史和 `artifacts/before-local-only-0.2.0/private-sync.spec.ts` 中。
- 相关单元测试：6 个测试文件、42 项全部通过。包含新增 14 项生态边界测试，以及更新策略、数据目录和插件窗口回归检查。
- 新增边界测试验证：拒绝执行旧 IPC 处理器，在宿主 HTTP 层发起网络请求前拒绝旧服务域名，保留本地插件、全局快捷键及用户配置的 AI 服务。
- TypeScript 类型检查、设置插件及 Electron 生产构建通过。

日志：`artifacts/local-only-e2e.log`、`artifacts/local-only-unit-final.log`、`artifacts/local-only-build-win.log`。

先完成源码 E2E，再构建供人工体验的 Windows x64 安装器及 ZIP；不自动安装。微信应用和短信后端尚未配置，没有二维码、验证码发送或模拟登录成功的行为。

本次未复跑完整上游单元测试集。0.2.0 时代的全量结果为 72 个测试文件通过、6 个失败；这些失败曾在未修改的上游提交中复现，日志仍保存在 `artifacts/unit-final.log` 和 `artifacts/upstream-baseline-tests.log`。本次移除服务后，部分原云服务测试的行为契约也已不适用于当前产品，不能将旧结果视为 0.2.1 的全量验证结果。

产品中的市场、云账号、同步、通知和官方 AI 不再可用；部分上游实现源码保留作兼容参考，并由产品策略和 IPC 边界拒绝调用。MIT 许可证及来源说明保留。用户已有本地插件和数据不作删除处理。

0.2.3 分发验证补充：pnpm build:win 通过，安装器和 ZIP 已生成，SHA256SUMS-0.2.3.txt 已保存。本机覆盖升级安装器退出码为 0；实际安装版本 0.2.3.0，EXE 与 app.asar 哈希与构建一致，全部内置插件文件逐项比对一致。sTools 已重新启动。部署结果：artifacts/market-deployment.json。

0.2.4 分发验证：Windows 安装包与 ZIP 构建通过。本机覆盖升级退出码 0，安装版本 0.2.4.0；EXE、app.asar 和全部内置插件文件与构建一致，sTools 已重新启动。校验文件 release/SHA256SUMS-0.2.4.txt，部署报告 artifacts/search-deployment.json。

0.2.5 分发验证：Windows 安装器构建通过，本机覆盖升级退出码 0，实际版本 0.2.5.0；EXE、app.asar 以及全部 73 个内置插件文件与构建一致。sTools 已重新启动。校验文件 release/SHA256SUMS-0.2.5.txt，部署报告 artifacts/layout-deployment.json。

0.3.0 最终源码 Electron 回归：29 项全部通过（artifacts/builtin-e2e-final.log），含内置搜索、原有 Everything、插件市场、快捷键、登录入口和窗口布局。前一次回归的启动用例在退出清理阶段超时；最终完整运行该用例及清理均通过。

0.3.0 分发验证：Windows NSIS 安装器构建通过，本机覆盖升级退出码 0，版本 0.3.0.0；EXE、app.asar、内置索引工作线程和全部 73 个内置插件文件与构建一致。sTools 已重新启动。报告 artifacts/builtin-deployment.json。

复测过程记录：带追踪的复测出现 Electron 退出清理超时，且桌面自动粘贴曾干扰分页用例。已隔离 E2E 真实剪贴板，并修复无变化索引复核及迟到状态轮询导致分页重置的问题。独立退出诊断正常；最终搜索及相关回归关闭 trace 运行，保留原功能断言。历史失败日志仍保留在 artifacts/fast-e2e-final.log 和 artifacts/fast-e2e-isolated.log。

0.4.0 最终验证：16 项专项 Electron E2E 全部通过（关闭 trace，artifacts/fast-e2e-verified.log），16 项相关单元测试和 4 项 C# 解析器检查通过。首轮全量 31 项曾全部通过，复测中的退出追踪超时与分页缺陷及修复过程均保留记录。

0.4.0 分发：本机已覆盖升级，安装器退出码 0；文件版本 0.4.0，主 EXE、app.asar、4 个搜索资源以及 73 个内置插件文件与构建一致。4 个 sTools 进程已运行；内置索引可读取，检查时共 469896 项。独立 sToolsSearch 服务未安装，等待明确授权；未进行真实卷 MFT/USN 加速实测。报告 artifacts/fast-deployment.json、artifacts/fast-installed-index.json，校验文件 release/SHA256SUMS-0.4.0.txt。

0.5.0 本机部署完成：安装器退出码 0，版本由 0.4.2 升至 0.5.0，主 EXE、app.asar、80 个内置插件文件、12 个截图资源和 6 个搜索资源逐项 SHA256 相同。已备份原搜索配置并将引擎切换为 Everything；原有索引范围、排除目录、数据库和快捷键保留。没有修改 sToolsSearch 服务。sTools 已重新启动。

已安装的 SDK 组件以当前用户身份连接本机 Everything 1.4.1.1032，状态 ready，检查时索引 908011 项；对已知项目 README 的原生路径表达式查询返回唯一正确结果。报告 `artifacts/sdk-installed-verification.json`。安装包 `release/sTools-0.5.0-win-x64-setup.exe`，SHA256 `A0D74C73710C64FC5DD0D907846113FE71801051C2436B379BB343FB3A0563D6`。
