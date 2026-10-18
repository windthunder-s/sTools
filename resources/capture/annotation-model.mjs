/**
 * 标注对象基类 - 支持选中、移动、缩放、旋转
 */
export class Annotation {
  /**
   * 创建标注对象
   * @param {string} type - 标注类型（rect/ellipse/arrow/brush/marker/text/mosaic/line/number）
   * @param {object} bounds - 边界框 {x, y, width, height}
   * @param {object} style - 样式 {color, width}
   * @param {string} id - 唯一标识
   */
  constructor(type, bounds, style, id = null) {
    this.id = id || `ann_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    this.type = type
    this.bounds = { ...bounds }
    this.style = { ...style }
    this.selected = false
    this.rotation = 0 // 旋转角度（弧度）
    this.zIndex = 0 // 层级

    // 类型特定数据
    this.data = {}
    if (type === 'arrow') {
      this.data.start = { x: bounds.x, y: bounds.y }
      this.data.end = { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
    } else if (type === 'brush' || type === 'marker') {
      this.data.points = []
    } else if (type === 'text') {
      this.data.text = ''
      this.data.fontSize = 18 + style.width * 2
    } else if (type === 'number') {
      this.data.number = 1
      this.data.fontSize = 20
    }
  }

  /**
   * 碰撞检测 - 判断点是否在标注内
   * @param {object} point - 测试点 {x, y}
   * @param {number} tolerance - 容差（像素）
   * @returns {boolean} 是否命中
   */
  hitTest(point, tolerance = 8) {
    const { x, y, width, height } = this.bounds

    if (this.type === 'arrow' || this.type === 'line') {
      // 线段碰撞：点到线段的距离
      const { start, end } = this.data
      const dist = this._pointToSegmentDistance(point, start, end)
      return dist <= tolerance + this.style.width / 2
    }

    if (this.type === 'brush' || this.type === 'marker') {
      // 画笔：检查点是否在路径附近
      const points = this.data.points
      if (!points || points.length === 0) return false
      for (let i = 0; i < points.length - 1; i++) {
        const dist = this._pointToSegmentDistance(point, points[i], points[i + 1])
        if (dist <= tolerance + this.style.width / 2) return true
      }
      return false
    }

    // 矩形、圆形、文字、马赛克、序号：边界框检测
    return (
      point.x >= x - tolerance &&
      point.x <= x + width + tolerance &&
      point.y >= y - tolerance &&
      point.y <= y + height + tolerance
    )
  }

  /**
   * 点到线段的最短距离
   * @private
   */
  _pointToSegmentDistance(point, start, end) {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const len2 = dx * dx + dy * dy

    if (len2 === 0) {
      // 起点终点重合
      return Math.hypot(point.x - start.x, point.y - start.y)
    }

    // 投影参数
    let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))

    const projX = start.x + t * dx
    const projY = start.y + t * dy
    return Math.hypot(point.x - projX, point.y - projY)
  }

  /**
   * 获取选中控制点（8个缩放手柄）
   * @returns {Array} 控制点数组 [{x, y, cursor, handle}]
   */
  getHandles() {
    const { x, y, width, height } = this.bounds
    const handles = [
      { x: x, y: y, cursor: 'nw-resize', handle: 'nw' },
      { x: x + width / 2, y: y, cursor: 'n-resize', handle: 'n' },
      { x: x + width, y: y, cursor: 'ne-resize', handle: 'ne' },
      { x: x + width, y: y + height / 2, cursor: 'e-resize', handle: 'e' },
      { x: x + width, y: y + height, cursor: 'se-resize', handle: 'se' },
      { x: x + width / 2, y: y + height, cursor: 's-resize', handle: 's' },
      { x: x, y: y + height, cursor: 'sw-resize', handle: 'sw' },
      { x: x, y: y + height / 2, cursor: 'w-resize', handle: 'w' }
    ]

    // 旋转按钮（在顶部中心上方）
    if (this.type !== 'brush' && this.type !== 'marker') {
      handles.push({
        x: x + width / 2,
        y: y - 20,
        cursor: 'grab',
        handle: 'rotate'
      })
    }

    return handles
  }

  /**
   * 移动标注
   * @param {number} dx - X轴偏移
   * @param {number} dy - Y轴偏移
   */
  move(dx, dy) {
    this.bounds.x += dx
    this.bounds.y += dy

    // 更新类型特定数据
    if (this.type === 'arrow' || this.type === 'line') {
      this.data.start.x += dx
      this.data.start.y += dy
      this.data.end.x += dx
      this.data.end.y += dy
    } else if (this.type === 'brush' || this.type === 'marker') {
      this.data.points = this.data.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
    }
  }

  /**
   * 调整大小
   * @param {string} handle - 控制手柄（nw/n/ne/e/se/s/sw/w）
   * @param {object} point - 当前鼠标位置
   * @param {boolean} keepAspect - 保持纵横比
   */
  resize(handle, point, keepAspect = false) {
    const { x, y, width, height } = this.bounds
    let newX = x, newY = y, newWidth = width, newHeight = height

    // 根据手柄调整边界
    if (handle.includes('w')) {
      newWidth = width + (x - point.x)
      newX = point.x
    }
    if (handle.includes('e')) {
      newWidth = point.x - x
    }
    if (handle.includes('n')) {
      newHeight = height + (y - point.y)
      newY = point.y
    }
    if (handle.includes('s')) {
      newHeight = point.y - y
    }

    // 保持纵横比
    if (keepAspect && (this.type === 'ellipse' || this.type === 'rect')) {
      const aspect = width / height
      if (Math.abs(newWidth / newHeight - aspect) > 0.1) {
        if (handle.includes('e') || handle.includes('w')) {
          newHeight = newWidth / aspect
          if (handle.includes('n')) newY = y + height - newHeight
        } else {
          newWidth = newHeight * aspect
          if (handle.includes('w')) newX = x + width - newWidth
        }
      }
    }

    // 最小尺寸限制
    if (Math.abs(newWidth) < 10 || Math.abs(newHeight) < 10) return

    // 处理负数（拖动超出边界）
    if (newWidth < 0) {
      newX += newWidth
      newWidth = -newWidth
    }
    if (newHeight < 0) {
      newY += newHeight
      newHeight = -newHeight
    }

    this.bounds = { x: newX, y: newY, width: newWidth, height: newHeight }

    // 更新箭头端点
    if (this.type === 'arrow' || this.type === 'line') {
      this.data.start = { x: newX, y: newY }
      this.data.end = { x: newX + newWidth, y: newY + newHeight }
    }
  }

  /**
   * 旋转标注
   * @param {number} angle - 旋转角度（弧度）
   */
  rotate(angle) {
    this.rotation = angle
  }

  /**
   * 渲染标注
   * @param {CanvasRenderingContext2D} ctx - 画布上下文
   * @param {number} scaleX - X轴缩放（显示坐标到物理像素）
   * @param {number} scaleY - Y轴缩放
   */
  render(ctx, scaleX = 1, scaleY = 1) {
    ctx.save()

    // 应用旋转
    if (this.rotation !== 0) {
      const centerX = this.bounds.x + this.bounds.width / 2
      const centerY = this.bounds.y + this.bounds.height / 2
      ctx.translate(centerX, centerY)
      ctx.rotate(this.rotation)
      ctx.translate(-centerX, -centerY)
    }

    ctx.strokeStyle = ctx.fillStyle = this.style.color
    ctx.lineWidth = this.style.width
    ctx.lineCap = ctx.lineJoin = 'round'

    const { x, y, width, height } = this.bounds

    switch (this.type) {
      case 'rect':
        ctx.strokeRect(x, y, width, height)
        break

      case 'ellipse':
        ctx.beginPath()
        ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
        break

      case 'arrow':
        this._renderArrow(ctx)
        break

      case 'line':
        ctx.beginPath()
        ctx.moveTo(this.data.start.x, this.data.start.y)
        ctx.lineTo(this.data.end.x, this.data.end.y)
        ctx.stroke()
        break

      case 'brush':
        this._renderPath(ctx, false)
        break

      case 'marker':
        ctx.save()
        ctx.globalAlpha = 0.32
        ctx.lineWidth = this.style.width * 6
        ctx.lineCap = 'butt'
        this._renderPath(ctx, false)
        ctx.restore()
        break

      case 'text':
        ctx.font = `${this.data.fontSize}px "Microsoft YaHei",sans-serif`
        ctx.textBaseline = 'top'
        this.data.text.split('\n').forEach((line, index) => {
          ctx.fillText(line, x, y + index * this.data.fontSize * 1.4)
        })
        break

      case 'number':
        // 绘制圆形背景
        const radius = 18
        ctx.beginPath()
        ctx.arc(x + radius, y + radius, radius, 0, Math.PI * 2)
        ctx.fillStyle = this.style.color
        ctx.fill()

        // 绘制数字
        ctx.fillStyle = '#ffffff'
        ctx.font = `bold ${this.data.fontSize}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(this.data.number), x + radius, y + radius)
        break

      case 'mosaic':
        this._renderMosaic(ctx, scaleX, scaleY)
        break
    }

    ctx.restore()
  }

  /**
   * 渲染箭头
   * @private
   */
  _renderArrow(ctx) {
    const { start, end } = this.data
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()

    // 箭头三角形
    const angle = Math.atan2(end.y - start.y, end.x - start.x)
    const arrowSize = 12 + this.style.width * 2
    ctx.beginPath()
    ctx.moveTo(end.x, end.y)
    ctx.lineTo(
      end.x - arrowSize * Math.cos(angle - 0.45),
      end.y - arrowSize * Math.sin(angle - 0.45)
    )
    ctx.lineTo(
      end.x - arrowSize * Math.cos(angle + 0.45),
      end.y - arrowSize * Math.sin(angle + 0.45)
    )
    ctx.closePath()
    ctx.fill()
  }

  /**
   * 渲染路径（画笔/荧光笔）
   * @private
   */
  _renderPath(ctx, fill = false) {
    const points = this.data.points
    if (!points || points.length === 0) return

    const moved = points.some(p => p.x !== points[0].x || p.y !== points[0].y)
    if (moved) {
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.stroke()
    } else {
      // 单点
      ctx.beginPath()
      ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /**
   * 渲染马赛克（需要原图数据）
   * @private
   */
  _renderMosaic(ctx, scaleX, scaleY) {
    // 马赛克渲染需要在上层实现，这里保留接口
  }

  /**
   * 序列化为 JSON
   * @returns {object} 可序列化对象
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      bounds: { ...this.bounds },
      style: { ...this.style },
      rotation: this.rotation,
      zIndex: this.zIndex,
      data: JSON.parse(JSON.stringify(this.data))
    }
  }

  /**
   * 从 JSON 恢复
   * @param {object} json - 序列化数据
   * @returns {Annotation} 标注实例
   */
  static fromJSON(json) {
    const ann = new Annotation(json.type, json.bounds, json.style, json.id)
    ann.rotation = json.rotation || 0
    ann.zIndex = json.zIndex || 0
    ann.data = json.data || {}
    return ann
  }

  /**
   * 克隆标注
   * @returns {Annotation} 新实例
   */
  clone() {
    return Annotation.fromJSON(this.toJSON())
  }
}

/**
 * 标注管理器 - 管理所有标注对象
 */
export class AnnotationManager {
  constructor() {
    this.annotations = []
    this.selectedAnnotation = null
    this.nextNumberValue = 1 // 序号标记的下一个数字
  }

  /**
   * 添加标注
   * @param {Annotation} annotation - 标注对象
   * @returns {Annotation} 添加的标注
   */
  addAnnotation(annotation) {
    // 自动设置 zIndex
    annotation.zIndex = this.annotations.length

    // 序号自动递增
    if (annotation.type === 'number') {
      annotation.data.number = this.nextNumberValue++
    }

    this.annotations.push(annotation)
    return annotation
  }

  /**
   * 移除标注
   * @param {string} id - 标注ID
   * @returns {boolean} 是否成功移除
   */
  removeAnnotation(id) {
    const index = this.annotations.findIndex(a => a.id === id)
    if (index >= 0) {
      const removed = this.annotations.splice(index, 1)[0]
      if (this.selectedAnnotation?.id === id) {
        this.selectedAnnotation = null
      }
      // 重新计算序号
      if (removed.type === 'number') {
        this._recalculateNumbers()
      }
      return true
    }
    return false
  }

  /**
   * 重新计算序号标记
   * @private
   */
  _recalculateNumbers() {
    let num = 1
    this.annotations
      .filter(a => a.type === 'number')
      .sort((a, b) => a.zIndex - b.zIndex)
      .forEach(a => {
        a.data.number = num++
      })
    this.nextNumberValue = num
  }

  /**
   * 在指定位置选中标注
   * @param {object} point - 点击位置 {x, y}
   * @param {number} tolerance - 容差
   * @returns {Annotation|null} 选中的标注
   */
  selectAt(point, tolerance = 8) {
    // 从上到下查找（zIndex 从大到小）
    const sorted = [...this.annotations].sort((a, b) => b.zIndex - a.zIndex)

    for (const ann of sorted) {
      if (ann.hitTest(point, tolerance)) {
        this.clearSelection()
        ann.selected = true
        this.selectedAnnotation = ann
        return ann
      }
    }

    // 未命中任何标注
    this.clearSelection()
    return null
  }

  /**
   * 清除选中状态
   */
  clearSelection() {
    if (this.selectedAnnotation) {
      this.selectedAnnotation.selected = false
      this.selectedAnnotation = null
    }
  }

  /**
   * 移动选中的标注
   * @param {number} dx - X轴偏移
   * @param {number} dy - Y轴偏移
   * @returns {boolean} 是否有标注被移动
   */
  moveSelected(dx, dy) {
    if (this.selectedAnnotation) {
      this.selectedAnnotation.move(dx, dy)
      return true
    }
    return false
  }

  /**
   * 删除选中的标注
   * @returns {boolean} 是否删除成功
   */
  deleteSelected() {
    if (this.selectedAnnotation) {
      return this.removeAnnotation(this.selectedAnnotation.id)
    }
    return false
  }

  /**
   * 将标注置于顶层
   * @param {string} id - 标注ID
   */
  bringToFront(id) {
    const ann = this.annotations.find(a => a.id === id)
    if (ann) {
      const maxZ = Math.max(...this.annotations.map(a => a.zIndex))
      ann.zIndex = maxZ + 1
    }
  }

  /**
   * 将标注置于底层
   * @param {string} id - 标注ID
   */
  sendToBack(id) {
    const ann = this.annotations.find(a => a.id === id)
    if (ann) {
      const minZ = Math.min(...this.annotations.map(a => a.zIndex))
      ann.zIndex = minZ - 1
    }
  }

  /**
   * 获取所有标注（按 zIndex 排序）
   * @returns {Array<Annotation>} 排序后的标注数组
   */
  getSortedAnnotations() {
    return [...this.annotations].sort((a, b) => a.zIndex - b.zIndex)
  }

  /**
   * 清空所有标注
   */
  clear() {
    this.annotations = []
    this.selectedAnnotation = null
    this.nextNumberValue = 1
  }

  /**
   * 导出为 JSON
   * @returns {Array} 可序列化数组
   */
  toJSON() {
    return this.annotations.map(a => a.toJSON())
  }

  /**
   * 从 JSON 导入
   * @param {Array} json - 序列化数据
   */
  fromJSON(json) {
    this.clear()
    if (Array.isArray(json)) {
      json.forEach(data => {
        const ann = Annotation.fromJSON(data)
        this.annotations.push(ann)
      })
      // 重新计算序号
      this._recalculateNumbers()
    }
  }
}
