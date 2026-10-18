# 截图插件全面重构计划

## 目标
完全对齐 Snipaste 和 QQ 的截图、录屏、长截图功能。

## 一、架构重构（P0 - 基础）

### 1.1 标注对象模型重构
**当前问题**：标注存储为简单操作数组，无法二次编辑
**目标**：实现完整的对象模型，支持选中、移动、缩放、旋转

```javascript
// 新增 resources/capture/annotation-model.mjs
class Annotation {
  constructor(type, bounds, style, id)
  hitTest(point)           // 碰撞检测
  render(ctx)              // 绘制
  getBounds()              // 获取边界
  move(dx, dy)             // 移动
  resize(handle, point)    // 调整大小
  rotate(angle)            // 旋转
  toJSON()                 // 序列化
  clone()                  // 克隆
}

class AnnotationManager {
  annotations: Annotation[]
  selectedAnnotation: Annotation | null
  addAnnotation(annotation)
  removeAnnotation(id)
  selectAt(point)
  clearSelection()
  moveSelected(dx, dy)
  deleteSelected()
  bringToFront(id)
  sendToBack(id)
}
```

### 1.2 渲染优化
**当前问题**：每次全量重绘所有标注
**优化**：脏区域刷新 + 离屏 canvas 缓存

```javascript
// 修改 editor.mjs 渲染策略
- 增加脏矩形追踪
- 标注完成后缓存到离屏 canvas
- 只重绘变化区域
```

## 二、Snipaste 核心功能（P0）

### 2.1 窗口自动吸附 ✅
**实现**：
- 主进程：通过 `desktopCapturer.getSources({ types: ['window'] })` 获取所有窗口边界
- 前端：框选时显示辅助线，靠近窗口边界自动吸附（误差 8px）

**文件修改**：
- `src/main/api/renderer/captureTools.ts` - 新增 `capture:get-windows` IPC
- `resources/capture/editor.mjs` - 新增吸附逻辑
- `resources/capture/capture.css` - 新增辅助线样式

### 2.2 取色器 + 放大镜 ✅
**实现**：
- 鼠标移动时实时获取像素颜色
- 显示 11×11 放大预览（中心十字）
- 显示 RGB/HEX 值
- 点击取色后自动切换到标注工具

**文件修改**：
- `resources/capture/editor.html` - 新增放大镜 UI
- `resources/capture/editor.mjs` - 新增取色逻辑
- `resources/capture/capture.css` - 放大镜样式

### 2.3 标注对象可编辑 ✅
**实现**：
- 完成的标注可点选（显示控制点）
- 支持拖动移动
- 八点缩放手柄
- Delete 键删除
- 右键菜单：删除、置顶、置底、复制样式

**文件修改**：
- `resources/capture/annotation-model.mjs` - 新建对象模型
- `resources/capture/editor.mjs` - 重构标注管理

### 2.4 截图历史 ✅
**实现**：
- 本地 SQLite 数据库存储最近 100 张
- 快捷键 Ctrl+H 打开历史面板
- 缩略图 + 时间戳
- 支持搜索、删除、重新编辑

**文件修改**：
- `src/main/core/captureHistory.ts` - 新建历史管理
- `resources/capture/history.html` - 新建历史界面
- `resources/capture/history.mjs` - 历史逻辑

### 2.5 新增工具 ✅
- 直线工具
- 序号标记（1、2、3...自动递增）
- 马赛克预设（小、中、大）

### 2.6 图钉管理器 ✅
**实现**：
- 右下角托盘图标右键 "管理贴图"
- 显示所有贴图窗口列表
- 支持聚焦、关闭、批量关闭

**文件修改**：
- `src/main/api/renderer/captureTools.ts` - 贴图窗口注册
- `resources/capture/pin-manager.html` - 管理界面

### 2.7 交互优化 ✅
- 方向性光标（nw-resize, ne-resize, move 等）
- 工具切换时工具栏图标高亮动画
- 标注时半透明预览

## 三、QQ 录屏功能（P1）

### 3.1 摄像头画中画 ✅
**实现**：
- 准备页面新增"开启摄像头"选项
- 摄像头预览窗口可拖动、调整大小
- 录制时合成到视频画面

**文件修改**：
- `resources/capture/recorder.html` - 新增摄像头选项
- `resources/capture/recorder.mjs` - MediaStream 合成

### 3.2 实时涂鸦 ✅
**实现**：
- 录制时显示标注工具栏
- 支持画笔、箭头、文字
- 涂鸦直接录入视频

**文件修改**：
- `resources/capture/recorder.mjs` - Canvas 叠加层

### 3.3 鼠标高亮 + 按键显示 ✅
**实现**：
- 鼠标周围黄色光圈（可配置大小和颜色）
- 左下角显示按键（Ctrl、Shift、鼠标左/右键）
- 使用 uiohook-napi 监听全局输入

**文件修改**：
- `src/main/core/inputMonitor.ts` - 新建输入监听
- `resources/capture/recorder.mjs` - 高亮渲染

### 3.4 视频剪辑 ✅
**实现**：
- 录制完成后显示时间轴
- 拖动开头/结尾裁剪
- 使用 Web Codecs API 重新编码

**文件修改**：
- `resources/capture/video-trim.html` - 剪辑界面
- `resources/capture/video-trim.mjs` - 剪辑逻辑

### 3.5 输出选项增强 ✅
- 分辨率自定义（最高 4K）
- 帧率选择（15/24/30/60 fps）
- 比特率选择（低/中/高/自定义）
- GIF 自定义时长和尺寸

## 四、长截图增强（P2）

### 4.1 自动滚动 ✅
**实现**：
- 使用 Electron 的 `webContents.sendInputEvent` 模拟滚轮
- 智能识别滚动完成（画面稳定）
- 支持加速滚动

**文件修改**：
- `resources/capture/scroll.mjs` - 新增自动模式

### 4.2 横向拼接 ✅
**实现**：
- 支持左右滚动拼接
- 智能识别固定列

**文件修改**：
- `resources/capture/horizontal-stitch.mjs` - 新建横向算法

### 4.3 固定栏识别 ✅
**实现**：
- 检测顶部/底部固定栏（连续帧相同区域）
- 自动裁切固定栏，只保留一份

**文件修改**：
- `resources/capture/vertical-stitch.mjs` - 增强算法

### 4.4 长图标注 ✅
**实现**：
- 长截图完成后进入编辑模式
- 支持滚动查看和标注
- 标注位置固定到像素坐标

**文件修改**：
- `resources/capture/long-editor.html` - 长图编辑器
- `resources/capture/long-editor.mjs` - 编辑逻辑

## 五、实施顺序

### 阶段 1：基础架构（1-2天）
1. 重构标注对象模型
2. 优化渲染性能
3. 建立测试框架

### 阶段 2：Snipaste P0（2-3天）
4. 窗口吸附
5. 取色器 + 放大镜
6. 标注可编辑
7. 截图历史

### 阶段 3：Snipaste P1（1天）
8. 新增工具（直线、序号）
9. 图钉管理器
10. 交互优化

### 阶段 4：QQ 录屏（2-3天）
11. 摄像头画中画
12. 实时涂鸦
13. 鼠标高亮 + 按键
14. 视频剪辑
15. 输出选项

### 阶段 5：长截图增强（1-2天）
16. 自动滚动
17. 横向拼接
18. 固定栏识别
19. 长图标注

### 阶段 6：测试与优化（1-2天）
20. 端到端测试
21. 性能优化
22. Bug 修复

## 六、技术风险评估

### 高风险
- ❌ 摄像头画中画合成（MediaRecorder API 限制）
- ❌ 视频剪辑（需要 Web Codecs API，浏览器支持）
- ❌ 自动滚动稳定性（不同应用响应不同）

### 中风险
- ⚠️ 标注对象旋转（需要复杂的变换矩阵）
- ⚠️ 固定栏识别准确率
- ⚠️ 大尺寸长图性能

### 低风险
- ✅ 窗口吸附
- ✅ 取色器
- ✅ 截图历史
- ✅ 标注可编辑

## 七、兼容性保证

- 保持现有 API 不变
- 新功能可选启用
- 测试用例全部通过后再合并
- 提供降级方案（不支持的功能隐藏）

---

**开始时间**：2026-10-15
**预计完成**：2026-10-25（10天）
**测试时间**：2026-10-26 - 2026-10-27（2天）
**发布版本**：0.7.0
