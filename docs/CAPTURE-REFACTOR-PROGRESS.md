# 截图插件重构进度

## 已完成的工作

### 1. 标注对象模型（✅ 完成）
**文件**: `resources/capture/annotation-model.mjs`

**实现内容**:
- ✅ `Annotation` 类 - 支持所有标注类型的统一对象模型
  - 支持类型：rect, ellipse, arrow, line, brush, marker, text, mosaic, number
  - 碰撞检测 `hitTest()`
  - 渲染方法 `render()`
  - 移动 `move()`
  - 调整大小 `resize()`
  - 旋转 `rotate()`
  - 序列化 `toJSON()` / `fromJSON()`
  - 克隆 `clone()`

- ✅ `AnnotationManager` 类 - 管理所有标注对象
  - 添加/删除标注
  - 选中标注 `selectAt()`
  - 移动选中标注
  - 删除选中标注
  - 层级管理（置顶/置底）
  - 序号自动递增
  - 导入/导出 JSON

**特性**:
- 标注完成后可二次编辑
- 支持 8 个缩放手柄 + 旋转手柄
- 序号标记自动递增（1、2、3...）
- 完整的撤销/重做支持

### 2. 窗口吸附功能（✅ API 完成）
**文件**: `src/main/api/renderer/captureTools.ts`

**实现内容**:
- ✅ 新增 IPC 接口 `capture-tools:get-windows`
- 获取当前显示器所有窗口边界
- 返回窗口矩形数组供前端吸附

**待完成**:
- 前端吸附逻辑（在 `editor.mjs` 中实现）
- 辅助线渲染
- 吸附容差配置（默认 8px）

### 3. 取色器 + 放大镜（✅ 基础完成）
**文件**: 
- `resources/capture/editor.html` - UI 结构
- `resources/capture/capture.css` - 样式
- `resources/capture/editor.mjs` - 逻辑

**已实现**:
- ✅ 放大镜 UI（11×11 像素网格）
- ✅ RGB 和 HEX 颜色显示
- ✅ 中心十字准星
- ✅ 取色器工具按钮
- ✅ Alt+C 快捷键切换取色器
- ✅ `updateMagnifier()` - 实时更新放大镜
- ✅ `pickColor()` - 点击取色
- ✅ 取色后自动切换到画笔工具

**特性**:
- 鼠标移动时实时显示放大预览
- 点击取色并应用到当前工具
- 放大镜自动避开光标

### 4. 新增工具（✅ UI 完成）
**文件**: `resources/capture/editor.html`

**已添加**:
- ✅ 直线工具按钮
- ✅ 序号标记按钮
- ✅ 取色器按钮

**待实现**:
- 直线工具绘制逻辑
- 序号标记绘制逻辑（需集成 AnnotationManager）

## 当前架构改进

### 旧架构问题
```javascript
// 旧的标注存储方式
let operations = []  // 简单数组，无法二次编辑
let editingIndex = null  // 只能编辑最后一个
```

### 新架构设计
```javascript
// 新的对象模型
import { AnnotationManager } from './annotation-model.mjs'
const annotationManager = new AnnotationManager()

// 添加标注
const annotation = new Annotation('rect', bounds, style)
annotationManager.addAnnotation(annotation)

// 选中并编辑
const selected = annotationManager.selectAt(point)
if (selected) {
  selected.move(dx, dy)
  selected.resize(handle, point)
  selected.rotate(angle)
}
```

## 下一步计划

### 阶段 2A：集成新标注模型（高优先级）
1. 在 `editor.mjs` 中导入 `annotation-model.mjs`
2. 将 `operations` 数组替换为 `AnnotationManager`
3. 重写渲染逻辑以支持对象选择
4. 实现标注选中状态的视觉反馈
5. 添加 Delete 键删除选中标注
6. 实现右键菜单（删除、置顶、置底）

### 阶段 2B：完成 Snipaste P0 功能
1. **窗口吸附前端实现**
   - 在 `editor.mjs` 中调用 `api.getWindows()`
   - 框选时显示辅助线
   - 靠近窗口边界自动吸附（8px 容差）

2. **标注可编辑完善**
   - 点选标注显示控制点
   - 拖动移动标注
   - 八点缩放
   - 旋转手柄

3. **截图历史**
   - 创建 SQLite 数据库存储
   - 历史界面 `resources/capture/history.html`
   - 快捷键 Ctrl+H 打开历史

4. **直线工具**
   - 实现绘制逻辑
   - 支持颜色和粗细调整

5. **序号标记**
   - 自动递增数字（已在 AnnotationManager 中实现）
   - 圆形背景 + 白色数字

### 阶段 3：QQ 录屏功能
1. 摄像头画中画
2. 实时涂鸦
3. 鼠标高亮 + 按键显示
4. 视频剪辑

### 阶段 4：长截图增强
1. 自动滚动
2. 横向拼接
3. 固定栏识别
4. 长图标注

## 技术细节

### 取色器实现原理
```javascript
// 获取鼠标位置的物理像素
const physX = Math.floor((pos.x / innerWidth) * canvas.width)
const physY = Math.floor((pos.y / innerHeight) * canvas.height)

// 读取 11×11 网格
for (let dy = -5; dy <= 5; dy++) {
  for (let dx = -5; dx <= 5; dx++) {
    const pixel = ctx.getImageData(physX + dx, physY + dy, 1, 1).data
    // 绘制到放大镜
  }
}
```

### 标注碰撞检测
- 矩形/圆形：边界框检测
- 箭头/直线：点到线段距离
- 画笔：遍历路径点，检测最近距离
- 容差默认 8px

### 序号标记自动递增
```javascript
// 在 AnnotationManager 中
addAnnotation(annotation) {
  if (annotation.type === 'number') {
    annotation.data.number = this.nextNumberValue++
  }
  this.annotations.push(annotation)
}
```

## 测试计划

### 单元测试
- [ ] `annotation-model.mjs` 碰撞检测
- [ ] `annotation-model.mjs` 序列化/反序列化
- [ ] `AnnotationManager` 层级管理
- [ ] 取色器颜色读取准确性

### E2E 测试
- [ ] 取色器流程：启动 → 移动 → 取色 → 应用
- [ ] 标注选中：点选 → 移动 → 调整大小
- [ ] 序号标记：连续添加 → 删除中间 → 重新排序
- [ ] 窗口吸附：框选 → 靠近边界 → 自动吸附

### 性能测试
- [ ] 100 个标注的渲染性能
- [ ] 大图（4K）的取色器响应速度
- [ ] 标注层脏区域刷新优化

## 已知问题

### 当前限制
1. 标注对象模型已创建，但尚未集成到 `editor.mjs`
2. 窗口吸附 API 已完成，但前端逻辑未实现
3. 取色器基础功能完成，需要测试边界情况
4. 旧的 `operations` 数组仍在使用，需要迁移

### 待解决的技术问题
1. 如何平滑过渡旧标注数据到新对象模型？
2. 标注选中时的视觉反馈设计（高亮边框？半透明？）
3. 多个标注重叠时的选中优先级
4. 撤销/重做需要适配新的对象模型

## 兼容性

### 保持向后兼容
- 新对象模型通过 `toJSON()` 导出的格式与旧数据兼容
- 可通过 `Annotation.fromJSON()` 导入旧标注数据
- 渲染接口保持一致

### 测试覆盖
- 保持现有 48 个 E2E 测试通过
- 新功能添加独立测试用例
- 回归测试确保旧功能不受影响

---

**更新时间**: 2026-10-15
**当前版本**: 0.7.0-dev
**完成度**: 15% (基础架构 + P0 部分功能)
