# 截图插件重构待办清单

## 当前状态
- ✅ 标注对象模型已完成 (`annotation-model.mjs`)
- ✅ 窗口吸附 API 已完成
- ✅ 取色器 + 放大镜基础功能已完成
- ✅ 新增工具按钮（直线、序号、取色器）已添加
- 📝 进度文档已更新

## 立即需要完成的工作

### 1. 集成新标注模型到 editor.mjs（高优先级）
**目标**: 将旧的 `operations` 数组替换为 `AnnotationManager`

**具体任务**:
```javascript
// 需要修改的部分
1. 导入 annotation-model.mjs
2. 替换全局变量：
   - operations -> annotationManager.annotations
   - editingIndex -> annotationManager.selectedAnnotation
3. 修改绘制逻辑：
   - canvas.onpointerdown - 添加选中标注逻辑
   - canvas.onpointermove - 显示移动/缩放光标
   - canvas.onpointerup - 完成标注或选中操作
4. 修改渲染函数：
   - render() - 使用 annotationManager.getSortedAnnotations()
   - 绘制选中标注的控制点
5. 添加键盘快捷键：
   - Delete - 删除选中标注
   - Ctrl+D - 复制选中标注
6. 实现右键菜单（可选）
```

**预计耗时**: 2-3 小时

### 2. 完成直线和序号工具（中优先级）
**文件**: `resources/capture/editor.mjs`

**直线工具**:
```javascript
// 在 canvas.onpointerdown 中添加
else if (tool === 'line') {
  drag = { mode: 'draw', start: p, before }
  preview = {
    tool: 'line',
    start: p,
    end: p,
    color: colorInput.value,
    width: Number(strokeInput.value)
  }
}
```

**序号工具**:
```javascript
else if (tool === 'number') {
  const annotation = new Annotation('number', {
    x: p.x - 18,
    y: p.y - 18,
    width: 36,
    height: 36
  }, {
    color: colorInput.value,
    width: Number(strokeInput.value)
  })
  annotationManager.addAnnotation(annotation)
  remember(before.state)
}
```

**预计耗时**: 1 小时

### 3. 实现窗口吸附前端逻辑（中优先级）
**文件**: `resources/capture/editor.mjs`

**步骤**:
```javascript
// 1. 启动时获取窗口边界
let windowBounds = []
async function loadWindowBounds() {
  try {
    windowBounds = await api.getWindows(state.displayId)
  } catch (e) {
    windowBounds = []
  }
}

// 2. 在 canvas.onpointermove 中添加吸附逻辑
function snapToBounds(rect, threshold = 8) {
  for (const win of windowBounds) {
    // 检查四条边是否接近窗口边界
    if (Math.abs(rect.x - win.x) < threshold) rect.x = win.x
    if (Math.abs(rect.y - win.y) < threshold) rect.y = win.y
    if (Math.abs(rect.x + rect.width - (win.x + win.width)) < threshold) {
      rect.x = win.x + win.width - rect.width
    }
    if (Math.abs(rect.y + rect.height - (win.y + win.height)) < threshold) {
      rect.y = win.y + win.height - rect.height
    }
  }
  return rect
}

// 3. 渲染辅助线
function renderSnapGuides(ctx) {
  ctx.strokeStyle = '#ff6b00'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  for (const win of windowBounds) {
    ctx.strokeRect(win.x, win.y, win.width, win.height)
  }
  ctx.setLineDash([])
}
```

**预计耗时**: 1-2 小时

### 4. 截图历史功能（低优先级 - 后续版本）
**文件**: 
- `src/main/core/captureHistory.ts` (新建)
- `resources/capture/history.html` (新建)
- `resources/capture/history.mjs` (新建)

**数据库结构**:
```sql
CREATE TABLE screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  dataUrl TEXT NOT NULL,
  annotations TEXT, -- JSON
  tags TEXT
);
```

**预计耗时**: 3-4 小时

## 测试计划

### 单元测试
```bash
# 需要创建的测试文件
tests/capture/annotation-model.test.mjs
tests/capture/color-picker.test.mjs
tests/capture/window-snap.test.mjs
```

### E2E 测试
```bash
# 需要更新的测试
tests/e2e/capture-tools.spec.ts
tests/e2e/capture-modes.spec.ts
```

### 手动测试清单
- [ ] 取色器：移动鼠标 → 看到放大镜 → 点击取色 → 颜色应用
- [ ] 直线工具：选择工具 → 拖动绘制 → 调整颜色粗细
- [ ] 序号工具：连续点击 → 自动递增 → 删除中间序号 → 重新排序
- [ ] 窗口吸附：框选 → 靠近窗口边界 → 自动吸附（视觉反馈）
- [ ] 标注选中：点选标注 → 显示控制点 → 拖动移动 → 调整大小

## 下一阶段计划

### 阶段 3：QQ 录屏功能（未开始）
- [ ] 摄像头画中画
- [ ] 实时涂鸦
- [ ] 鼠标高亮 + 按键显示
- [ ] 视频剪辑

### 阶段 4：长截图增强（未开始）
- [ ] 自动滚动
- [ ] 横向拼接
- [ ] 固定栏识别
- [ ] 长图标注

## 技术债务

### 需要重构的部分
1. **渲染性能优化**
   - 当前每次操作都全量重绘
   - 需要实现脏区域刷新
   - 离屏 canvas 缓存

2. **撤销/重做系统**
   - 当前限制 100 步
   - 大图标注会快速耗尽
   - 需要实现增量快照

3. **内存管理**
   - 长截图大图处理
   - 标注数据压缩
   - 历史记录清理策略

## 已知问题

### Bug 清单
- [ ] 取色器在屏幕边缘时放大镜可能超出边界
- [ ] 旧标注数据迁移未实现
- [ ] 多显示器支持待验证
- [ ] 快捷键冲突检测不完善

### 限制
- 窗口吸附 API 目前返回空数组（需要平台特定实现）
- 取色器在高 DPI 屏幕上可能有偏移
- 序号标记删除后可能导致编号跳跃

## 文件清单

### 已创建/修改
- ✅ `resources/capture/annotation-model.mjs` (新建)
- ✅ `resources/capture/editor.html` (修改)
- ✅ `resources/capture/editor.mjs` (修改)
- ✅ `resources/capture/capture.css` (修改)
- ✅ `src/main/api/renderer/captureTools.ts` (修改)
- ✅ `docs/CAPTURE-REFACTOR-PLAN.md` (新建)
- ✅ `docs/CAPTURE-REFACTOR-PROGRESS.md` (新建)

### 待创建
- ⏳ `tests/capture/annotation-model.test.mjs`
- ⏳ `tests/capture/color-picker.test.mjs`
- ⏳ `src/main/core/captureHistory.ts`
- ⏳ `resources/capture/history.html`
- ⏳ `resources/capture/history.mjs`

## 构建和部署

### 构建命令（待测试）
```bash
# 检查类型
pnpm typecheck

# 运行测试
pnpm test
pnpm test:e2e

# 构建
pnpm build

# 生成分发包
pnpm build:win
```

### 版本规划
- **0.7.0-alpha.1**: 基础架构 + 取色器 + 标注可编辑
- **0.7.0-alpha.2**: 窗口吸附 + 新工具
- **0.7.0-beta.1**: 截图历史 + QQ 录屏基础
- **0.7.0**: 完整功能 + 所有测试通过

---

**最后更新**: 2026-10-15
**负责人**: Claude
**预计完成**: 2026-10-25
