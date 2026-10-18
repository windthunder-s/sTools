import { clamp, rectangle, pixels, handles, resize, toolbarPosition } from './geometry.mjs'
const api = window.capture,
  canvas = document.querySelector('#screen'),
  ctx = canvas.getContext('2d'),
  toolbar = document.querySelector('#toolbar'),
  options = document.querySelector('#tool-options'),
  badge = document.querySelector('#dimensions'),
  textInput = document.querySelector('#text'),
  colorInput = document.querySelector('#color'),
  strokeInput = document.querySelector('#stroke'),
  strokeOption = document.querySelector('.stroke-option'),
  strokeDot = document.querySelector('#stroke-dot'),
  shapeButton = document.querySelector('#shape'),
  annotationCanvas = document.createElement('canvas'),
  annotationCtx = annotationCanvas.getContext('2d'),
  magnifier = document.querySelector('#magnifier'),
  magCanvas = document.querySelector('#mag-canvas'),
  magCtx = magCanvas.getContext('2d'),
  magRgb = document.querySelector('#mag-rgb'),
  magHex = document.querySelector('#mag-hex')
const state = await api.describe(),
  image = new Image()
image.src = state.image
await image.decode()
canvas.width = image.naturalWidth
canvas.height = image.naturalHeight
annotationCanvas.width = canvas.width
annotationCanvas.height = canvas.height
let crop = null,
  strokeWidth = Number(strokeInput.value),
  tool = 'select',
  drag = null,
  operations = [],
  undoHistory = [],
  redo = [],
  editingIndex = null,
  preview = null,
  busy = false,
  textAnchor = null,
  textBefore = null,
  composingText = false,
  shapeTool = 'rect',
  pickerActive = false,
  lastMousePos = null
let recording = state.kind !== 'capture'
const copyIcon = document.querySelector('#confirm').innerHTML

/**
 * Reflect the chosen action without discarding the current crop or annotations.
 * @returns {void} No value.
 */
function syncMode() {
  recording = state.kind !== 'capture'
  for (const id of ['draw-tools', 'history-tools', 'save', 'pin'])
    document.querySelector('#' + id).hidden = recording
  document.querySelector('#record-tools').hidden = !recording
  document
    .querySelector(recording ? '#record-tools' : '#shape-options')
    .append(document.querySelector('#whole'))
  const confirm = document.querySelector('#confirm')
  const label = state.kind === 'scroll' ? '开始长截图' : '确认录屏区域'
  if (recording) confirm.textContent = label
  else confirm.innerHTML = copyIcon
  confirm.setAttribute('aria-label', recording ? label : '复制截图')
  confirm.title = recording ? label + ' (Enter)' : '复制截图 (Enter / Ctrl+C)'
  confirm.classList.toggle('record-confirm', recording)
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.kind))
    button.classList.toggle('selected', button.dataset.mode === state.kind)
  }
}

/**
 * Switch an uncommitted selection's action through the host's validated session transition.
 * @param {string} next Capture, recording, GIF or scrolling mode.
 * @returns {Promise<void>} Transition completion; failures remain visible in the editor.
 */
async function setMode(next) {
  if (busy || drag || next === state.kind) return
  finishText()
  setTool('select')
  busy = true
  try {
    await api.setMode(next)
    state.kind = next
    syncMode()
    document.querySelector('#error').textContent = ''
  } catch (failure) {
    document.querySelector('#error').textContent = failure.message
  } finally {
    busy = false
    render()
  }
}
for (const button of document.querySelectorAll('[data-mode]'))
  button.onclick = () => setMode(button.dataset.mode)
syncMode()

/**
 * Convert pointer input to bounded display coordinates.
 * @param {PointerEvent} event Pointer input.
 * @returns {object} Display-relative point.
 */
function point(event) {
  return {
    x: clamp(event.clientX, innerWidth),
    y: clamp(event.clientY, innerHeight)
  }
}
/**
 * Check whether a point is within the active crop.
 * @param {object} p Point in display coordinates.
 * @returns {boolean} Whether the point is inside the selection.
 */
function inside(p) {
  return (
    !!crop &&
    p.x >= crop.x &&
    p.x <= crop.x + crop.width &&
    p.y >= crop.y &&
    p.y <= crop.y + crop.height
  )
}
/**
 * Find the nearest resize handle, including the four edge midpoints.
 * @param {object} p Pointer location.
 * @returns {object|undefined} Hit handle.
 */
function hitHandle(p) {
  return (
    crop &&
    handles(crop)
      .filter((h) => Math.hypot(p.x - h.x, p.y - h.y) <= 8)
      .sort((a, b) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(p.x - b.x, p.y - b.y))[0]
  )
}
/**
 * Capture image operations and the active annotation's editing controls together.
 * @returns {object} Independent history state, without recursive history stacks.
 */
function captureSnapshot() {
  return {
    operations: structuredClone(operations),
    editingIndex,
    tool,
    shapeTool,
    color: colorInput.value,
    width: String(strokeWidth)
  }
}

/**
 * Restore a complete annotation state without committing or adding another history entry.
 * @param {object} snapshot Previously captured annotation state.
 * @returns {void} No value.
 */
function restoreSnapshot(snapshot) {
  operations = structuredClone(snapshot.operations)
  editingIndex = snapshot.editingIndex
  tool = snapshot.tool
  shapeTool = snapshot.shapeTool
  colorInput.value = snapshot.color
  strokeWidth = Number(snapshot.width)
  syncControls()
}

/**
 * Record one completed drawing or style edit and invalidate only the redo branch.
 * @param {object} before State immediately before the edit.
 * @returns {void} No value.
 */
function remember(before) {
  undoHistory.push(before)
  // Bound snapshots so long freehand sessions cannot retain unlimited copies of paths.
  if (undoHistory.length > 100) undoHistory.shift()
  redo = []
}

/**
 * Refresh tool selection, pixel width, pen preview and the current-edit hint from editor state.
 * @returns {void} No value.
 */
function syncControls() {
  // Keep the numeric control and bounded preview in sync after edits and history restores.
  strokeInput.value = String(strokeWidth)
  strokeDot.setAttribute('r', String(Math.min(20, strokeWidth) / 2))
  strokeDot.style.fill = colorInput.value
  const shapeActive = ['rect', 'ellipse'].includes(tool)
  shapeButton.classList.toggle('selected', shapeActive)
  shapeButton.setAttribute('aria-pressed', String(shapeActive))
  shapeButton.setAttribute('aria-expanded', String(shapeActive))
  document.querySelector('#shape-options').hidden = !shapeActive
  document.querySelector('#color-options').hidden = ['eraser', 'mosaic'].includes(tool)
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('selected', button.dataset.tool === tool)
    button.setAttribute('aria-pressed', String(button.dataset.tool === tool))
  }
  for (const button of document.querySelectorAll('[data-color]')) {
    const selected = button.dataset.color.toLowerCase() === colorInput.value.toLowerCase()
    button.classList.toggle('color-selected', selected)
    button.setAttribute('aria-pressed', String(selected))
  }
  textInput.style.color = colorInput.value
  textInput.style.fontSize = `${18 + strokeWidth * 2}px`
  const editing = editingIndex !== null || textAnchor !== null
  const status = document.querySelector('#edit-status')
  status.hidden = !editing
  status.textContent = textAnchor
    ? '正在输入文字 · Enter 完成 · Shift+Enter 换行'
    : '当前标注可调颜色和粗细 · 右键或切换工具完成'
  document.body.dataset.editingAnnotation = String(editing)
}

/**
 * Apply color and a positive integer pixel width to the current annotation and future drawings.
 * @param {string} color Chosen CSS color.
 * @param {string|number} width Pixel width; empty or nonfinite input retains the last valid value.
 * @returns {void} No value.
 */
function changeStyle(color, width) {
  // Ignore edits during a pointer operation so its preview and undo snapshot stay consistent.
  if (busy || drag) {
    syncControls()
    return
  }
  // Commit whole pixels at or above one without introducing another preset upper limit.
  const requestedWidth = Number(width)
  const nextWidth =
    String(width).trim() && Number.isFinite(requestedWidth)
      ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.round(requestedWidth)))
      : strokeWidth
  const current = editingIndex === null ? null : operations[editingIndex]
  // Restore the annotation's previous style when undoing a live color or width edit.
  if (current && (current.color !== color || current.width !== nextWidth)) {
    const before = captureSnapshot()
    before.color = current.color
    before.width = String(current.width)
    current.color = color
    current.width = nextWidth
    remember(before)
  }
  colorInput.value = color
  strokeWidth = nextWidth
  syncControls()
  render()
}

/**
 * Position the single-row toolbar and a separate contextual options panel beside the crop.
 * @returns {void} No value.
 */
function layout() {
  const valid = crop && crop.width >= 2 && crop.height >= 2
  toolbar.hidden = !valid || !!drag
  badge.hidden = !valid
  options.hidden = !valid || !!drag || tool === 'select' || recording
  document.querySelector('#hint').hidden = !!valid
  if (!valid) return
  const size = pixels(crop, canvas.width, canvas.height, innerWidth, innerHeight)
  document.querySelector('#size-value').textContent = `${size.width} × ${size.height}`
  badge.style.left = `${Math.max(0, Math.min(crop.x, innerWidth - badge.offsetWidth - 6))}px`
  badge.style.top = `${crop.y >= badge.offsetHeight + 6 ? crop.y - badge.offsetHeight - 6 : crop.y + 6}px`
  if (toolbar.hidden) return
  const pos = toolbarPosition(crop, toolbar.getBoundingClientRect(), innerWidth, innerHeight)
  toolbar.style.left = `${pos.x}px`
  toolbar.style.top = `${pos.y}px`
  toolbar.dataset.placement = pos.above ? 'above' : 'below'
  // A toolbar above a short crop must not cover the size label.
  if (pos.above) badge.style.top = `${crop.y + 6}px`
  if (!options.hidden) {
    const bar = toolbar.getBoundingClientRect()
    const panel = options.getBoundingClientRect()
    const active = (
      ['rect', 'ellipse'].includes(tool)
        ? shapeButton
        : document.querySelector(`[data-tool="${tool}"]`)
    ).getBoundingClientRect()
    const panelTop =
      pos.above && bar.top - panel.height - 5 >= 6
        ? bar.top - panel.height - 5
        : Math.min(bar.bottom + 5, innerHeight - panel.height - 6)
    options.style.left = `${Math.max(6, Math.min(active.left, innerWidth - panel.width - 6))}px`
    options.style.top = `${Math.max(6, panelTop)}px`
  }
}

/**
 * Draw an annotation on a separate layer; erasing can never remove original screenshot pixels.
 * @param {object} op Annotation data.
 * @returns {void} No value.
 */
function draw(op) {
  const ctx = annotationCtx
  ctx.save()
  const a = op.start,
    b = op.end || a,
    r = rectangle(a, b, innerWidth, innerHeight)
  ctx.strokeStyle = ctx.fillStyle = op.color
  ctx.lineWidth = op.width
  ctx.lineCap = ctx.lineJoin = 'round'
  ctx.beginPath()
  if (op.tool === 'rect') ctx.strokeRect(r.x, r.y, r.width, r.height)
  else if (op.tool === 'ellipse') {
    ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (op.tool === 'arrow') {
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    const angle = Math.atan2(b.y - a.y, b.x - a.x),
      s = 12 + op.width * 2
    ctx.beginPath()
    ctx.moveTo(b.x, b.y)
    ctx.lineTo(b.x - s * Math.cos(angle - 0.45), b.y - s * Math.sin(angle - 0.45))
    ctx.lineTo(b.x - s * Math.cos(angle + 0.45), b.y - s * Math.sin(angle + 0.45))
    ctx.closePath()
    ctx.fill()
  } else if (['brush', 'marker', 'eraser'].includes(op.tool)) {
    // A translucent highlighter and a layer-only eraser share the stroke path.
    if (op.tool === 'marker') {
      ctx.globalAlpha = 0.32
      ctx.lineWidth = op.width * 6
      ctx.lineCap = 'butt'
    } else if (op.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.lineWidth = Math.max(12, op.width * 6)
    }
    const moved = op.points.some((p) => p.x !== a.x || p.y !== a.y)
    if (moved) {
      ctx.moveTo(a.x, a.y)
      for (const p of op.points) ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else {
      // A click is a deliberate mark; Canvas does not paint a zero-length stroked path.
      ctx.arc(a.x, a.y, ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fill()
    }
  } else if (op.tool === 'text') {
    const size = 18 + op.width * 2
    ctx.font = `${size}px "Microsoft YaHei",sans-serif`
    ctx.textBaseline = 'top'
    op.text.split('\n').forEach((line, index) => ctx.fillText(line, a.x, a.y + index * size * 1.4))
  } else if (op.tool === 'mosaic' && r.width > 0 && r.height > 0) {
    const source = pixels(r, canvas.width, canvas.height, innerWidth, innerHeight),
      tiny = document.createElement('canvas')
    tiny.width = Math.max(1, Math.ceil(r.width / (op.width * 3)))
    tiny.height = Math.max(1, Math.ceil(r.height / (op.width * 3)))
    tiny
      .getContext('2d')
      .drawImage(
        canvas,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        tiny.width,
        tiny.height
      )
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(tiny, r.x, r.y, r.width, r.height)
    ctx.imageSmoothingEnabled = true
  }
  ctx.restore()
}
/**
 * Compose annotations and optionally show the selection mask and handles.
 * @param {boolean} decorations Whether editor decorations are visible.
 * @returns {void} No value.
 */
function render(decorations = true) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0)
  // Replay the editable layer separately so undo/redo also restores erased annotations.
  annotationCtx.setTransform(1, 0, 0, 1, 0, 0)
  annotationCtx.clearRect(0, 0, canvas.width, canvas.height)
  annotationCtx.setTransform(canvas.width / innerWidth, 0, 0, canvas.height / innerHeight, 0, 0)
  if (crop) {
    annotationCtx.save()
    annotationCtx.beginPath()
    annotationCtx.rect(crop.x, crop.y, crop.width, crop.height)
    annotationCtx.clip()
    if (!recording) for (const op of operations) draw(op)
    if (preview) draw(preview)
    annotationCtx.restore()
    ctx.drawImage(annotationCanvas, 0, 0)
  }
  if (!decorations) return
  ctx.setTransform(canvas.width / innerWidth, 0, 0, canvas.height / innerHeight, 0, 0)
  ctx.fillStyle = '#0007'
  if (!crop) ctx.fillRect(0, 0, innerWidth, innerHeight)
  else {
    ctx.fillRect(0, 0, innerWidth, crop.y)
    ctx.fillRect(0, crop.y + crop.height, innerWidth, innerHeight - crop.y - crop.height)
    ctx.fillRect(0, crop.y, crop.x, crop.height)
    ctx.fillRect(crop.x + crop.width, crop.y, innerWidth - crop.x - crop.width, crop.height)
    ctx.strokeStyle = '#409eff'
    ctx.lineWidth = 2
    ctx.strokeRect(crop.x, crop.y, crop.width, crop.height)
    ctx.lineWidth = 1
    for (const p of handles(crop)) {
      ctx.fillStyle = '#e6f2ff'
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4)
      ctx.strokeRect(p.x - 2, p.y - 2, 4, 4)
    }
  }
  document.querySelector('#undo').disabled = !undoHistory.length
  document.querySelector('#redo').disabled = !redo.length
  layout()
}
/**
 * Commit or discard the live text input before switching tools or exporting.
 * @param {boolean} commit Whether to add a nonempty annotation.
 * @returns {void} No value.
 */
function finishText(commit = true) {
  if (!textAnchor) return
  if (commit && textInput.value.trim()) {
    const before = textBefore || captureSnapshot()
    operations.push({
      tool: 'text',
      start: textAnchor,
      color: colorInput.value,
      width: strokeWidth,
      text: textInput.value
    })
    editingIndex = operations.length - 1
    remember(before)
  } else if (textBefore) {
    restoreSnapshot(textBefore)
  }
  textAnchor = null
  textBefore = null
  textInput.hidden = true
  textInput.value = ''
  syncControls()
  render()
}
/**
 * Activate an annotation tool; secondary shape, width and color options stay outside the main row.
 * @param {string} next Tool name.
 * @returns {void} No value.
 */
function setTool(next) {
  finishText()
  // Switching tools commits the current object; later style changes affect only a new object.
  editingIndex = null
  tool = next
  if (['rect', 'ellipse'].includes(tool)) shapeTool = tool

  // Handle picker tool
  if (tool === 'picker') {
    pickerActive = true
    canvas.style.cursor = 'crosshair'
    magnifier.hidden = false
  } else {
    pickerActive = false
    magnifier.hidden = true
    canvas.style.cursor = 'crosshair'
  }

  syncControls()
  layout()
}

/**
 * Update magnifier view at mouse position.
 * @param {object} pos Current mouse position {x, y}
 * @returns {void} No value.
 */
function updateMagnifier(pos) {
  if (!pickerActive || !pos) return

  // Get pixel color at mouse position
  const physX = Math.floor((pos.x / innerWidth) * canvas.width)
  const physY = Math.floor((pos.y / innerHeight) * canvas.height)

  if (physX < 0 || physX >= canvas.width || physY < 0 || physY >= canvas.height) return

  // Draw 11x11 pixel grid centered at cursor
  magCtx.imageSmoothingEnabled = false
  const gridSize = 11
  const halfGrid = Math.floor(gridSize / 2)

  for (let dy = -halfGrid; dy <= halfGrid; dy++) {
    for (let dx = -halfGrid; dx <= halfGrid; dx++) {
      const srcX = Math.max(0, Math.min(canvas.width - 1, physX + dx))
      const srcY = Math.max(0, Math.min(canvas.height - 1, physY + dy))
      const pixel = ctx.getImageData(srcX, srcY, 1, 1).data

      magCtx.fillStyle = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`
      magCtx.fillRect((dx + halfGrid) * 12, (dy + halfGrid) * 12, 12, 12)
    }
  }

  // Draw center crosshair
  magCtx.strokeStyle = '#ff0000'
  magCtx.lineWidth = 1
  magCtx.strokeRect(halfGrid * 12, halfGrid * 12, 12, 12)

  // Get center pixel color
  const centerPixel = ctx.getImageData(physX, physY, 1, 1).data
  const r = centerPixel[0]
  const g = centerPixel[1]
  const b = centerPixel[2]

  // Update color info
  magRgb.textContent = `RGB(${r}, ${g}, ${b})`
  const hex =
    '#' +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  magHex.textContent = hex

  // Position magnifier near cursor (offset to not cover cursor)
  magnifier.style.left = `${Math.min(innerWidth - 170, pos.x + 20)}px`
  magnifier.style.top = `${Math.min(innerHeight - 180, pos.y + 20)}px`
}

/**
 * Pick color at current position and apply to current tool.
 * @param {object} pos Click position {x, y}
 * @returns {void} No value.
 */
function pickColor(pos) {
  const physX = Math.floor((pos.x / innerWidth) * canvas.width)
  const physY = Math.floor((pos.y / innerHeight) * canvas.height)

  if (physX < 0 || physX >= canvas.width || physY < 0 || physY >= canvas.height) return

  const pixel = ctx.getImageData(physX, physY, 1, 1).data
  const hex =
    '#' + [pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, '0')).join('')

  colorInput.value = hex

  // Switch to previous drawing tool or default to brush
  const prevTool = tool === 'picker' ? 'brush' : tool
  setTool(prevTool)

  syncControls()
  render()
}
/**
 * Roll back interrupted pointer operations without losing the existing crop.
 * @returns {void} No value.
 */
function cancelDrag() {
  if (drag) {
    crop = drag.before.crop
    restoreSnapshot(drag.before.state)
    undoHistory = drag.before.undoHistory
    redo = drag.before.redo
  }
  drag = null
  preview = null
  render()
}
canvas.onpointerdown = (event) => {
  if (event.button !== 0 || busy) return
  finishText()
  const p = point(event)

  // Handle color picker click
  if (pickerActive && !crop) {
    pickColor(p)
    return
  }

  const handle = tool === 'select' && hitHandle(p)
  // Record the complete state so pointer cancellation cannot destroy a previous selection.
  const before = {
    crop: crop && { ...crop },
    state: captureSnapshot(),
    undoHistory: [...undoHistory],
    redo: [...redo]
  }
  if (tool === 'select' || !crop) {
    if (handle)
      drag = {
        mode: 'resize',
        handle: handle.name,
        original: { ...crop },
        before
      }
    else if (inside(p)) drag = { mode: 'move', start: p, original: { ...crop }, before }
    else {
      drag = { mode: 'select', start: p, before }
      crop = null
      operations = []
      undoHistory = []
      redo = []
      editingIndex = null
    }
  } else if (inside(p)) {
    editingIndex = null
    if (tool === 'text') {
      textBefore = before.state
      textAnchor = p
      textInput.hidden = false
      textInput.style.left = `${p.x}px`
      textInput.style.top = `${p.y}px`
      textInput.style.width = `${Math.max(30, crop.x + crop.width - p.x)}px`
      textInput.style.height = `${Math.max(30, Math.min(160, crop.y + crop.height - p.y))}px`
      textInput.style.color = colorInput.value
      textInput.style.fontSize = `${18 + strokeWidth * 2}px`
      syncControls()
      textInput.focus()
      return
    }
    drag = { mode: 'draw', start: p, before }
    preview = {
      tool,
      start: p,
      end: p,
      points: [p],
      color: colorInput.value,
      width: strokeWidth
    }
  }
  if (drag) canvas.setPointerCapture(event.pointerId)
  render()
}
canvas.onpointermove = (event) => {
  const p = point(event)
  lastMousePos = p

  // Update magnifier when picker tool is active
  if (pickerActive && !crop) {
    updateMagnifier(p)
  }

  if (!drag) {
    const handle = tool === 'select' && hitHandle(p)
    canvas.style.cursor = handle
      ? `${handle.name}-resize`
      : tool === 'select' && inside(p)
        ? 'move'
        : tool === 'text' && inside(p)
          ? 'text'
          : 'crosshair'
    return
  }
  if (drag.mode === 'move') {
    crop = {
      ...drag.original,
      x: clamp(drag.original.x + p.x - drag.start.x, innerWidth - drag.original.width),
      y: clamp(drag.original.y + p.y - drag.start.y, innerHeight - drag.original.height)
    }
  } else if (drag.mode === 'select') crop = rectangle(drag.start, p, innerWidth, innerHeight)
  else if (drag.mode === 'resize')
    crop = resize(drag.original, drag.handle, p, innerWidth, innerHeight)
  else if (preview) {
    // Keep annotations inside the selection even when the pointer leaves it while dragging.
    const end = {
      x: Math.max(crop.x, Math.min(p.x, crop.x + crop.width)),
      y: Math.max(crop.y, Math.min(p.y, crop.y + crop.height))
    }
    preview.end = end
    preview.points.push(end)
  }
  render()
}
canvas.onpointerup = () => {
  if (!drag) return
  // Freehand paths remain valid when they close at the start point, including a single dot.
  if (
    preview &&
    (['brush', 'marker', 'eraser'].includes(preview.tool) ||
      preview.start.x !== preview.end.x ||
      preview.start.y !== preview.end.y)
  ) {
    remember(drag.before.state)
    operations.push(preview)
    editingIndex = operations.length - 1
  }
  preview = null
  drag = null
  syncControls()
  render()
}
canvas.onpointercancel = cancelDrag
canvas.onlostpointercapture = () => {
  if (drag) cancelDrag()
}
/**
 * Adjust the pixel width one step per vertical wheel event on the canvas or width control.
 * @param {WheelEvent} event Wheel input from a supported editing surface.
 * @returns {void} No value.
 */
function handleWheel(event) {
  // Selection, recording and in-progress pointer operations do not consume width adjustments.
  if (!crop || busy || drag || tool === 'select' || tool === 'picker' || recording) return
  if (event.ctrlKey || event.metaKey || event.altKey || !event.deltaY) return

  event.preventDefault()

  // Normalize every mouse notch or touchpad wheel event to a single pixel, starting at 1 px.
  changeStyle(colorInput.value, Math.max(1, strokeWidth + (event.deltaY < 0 ? 1 : -1)))
}

/**
 * Apply valid input immediately and normalize unfinished numeric edits when committed.
 * @param {Event} event Input, change or blur event from the pixel width field.
 * @returns {void} No value.
 */
function handleStrokeInput(event) {
  // Allow temporary empty or fractional input without passing it to the drawing engine.
  const width = strokeInput.valueAsNumber
  if (event.type === 'input' && (!Number.isSafeInteger(width) || width < 1)) return
  changeStyle(colorInput.value, strokeInput.value)
}

// Suppress the native number-input wheel step so a gesture cannot adjust the width twice.
canvas.addEventListener('wheel', handleWheel, { passive: false })
strokeOption.addEventListener('wheel', handleWheel, { passive: false })
document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (busy) return
  if (drag) cancelDrag()
  else if (tool !== 'select' || textAnchor) setTool('select')
  else api.close()
})
shapeButton.onclick = () => setTool(['rect', 'ellipse'].includes(tool) ? 'select' : shapeTool)
for (const button of document.querySelectorAll('[data-tool]'))
  button.onclick = () => setTool(button.dataset.tool === tool ? 'select' : button.dataset.tool)
for (const button of document.querySelectorAll('[data-color]'))
  button.onclick = () => changeStyle(button.dataset.color, strokeInput.value)
colorInput.oninput = () => changeStyle(colorInput.value, strokeInput.value)
strokeInput.addEventListener('input', handleStrokeInput)
strokeInput.addEventListener('change', handleStrokeInput)
strokeInput.addEventListener('blur', handleStrokeInput)
document.querySelector('#undo').onclick = () => {
  if (busy || drag) return
  finishText()
  if (undoHistory.length) {
    redo.push(captureSnapshot())
    restoreSnapshot(undoHistory.pop())
  }
  render()
}
document.querySelector('#redo').onclick = () => {
  if (busy || drag) return
  finishText()
  if (redo.length) {
    undoHistory.push(captureSnapshot())
    restoreSnapshot(redo.pop())
  }
  render()
}
document.querySelector('#whole').onclick = () => {
  finishText()
  crop = { x: 0, y: 0, width: innerWidth, height: innerHeight }
  setTool('select')
  render()
}
document.querySelector('#cancel').onclick = () => api.close()

/**
 * Export only source pixels and annotations, or confirm the recording selection.
 * @param {string} action Copy, save or pin.
 * @returns {Promise<void>} Export completion.
 */
async function output(action) {
  if (busy || drag || !crop || crop.width < 2 || crop.height < 2) return
  finishText()
  busy = true
  document.querySelector('#error').textContent = ''
  try {
    if (state.kind === 'scroll') {
      await api.selectScroll(crop)
      return
    }
    if (recording) {
      await api.selectRecording(crop)
      return
    }
    render(false)
    const source = pixels(crop, canvas.width, canvas.height, innerWidth, innerHeight),
      result = document.createElement('canvas')
    result.width = source.width
    result.height = source.height
    result
      .getContext('2d')
      .drawImage(
        canvas,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        source.width,
        source.height
      )
    await api.image(action, result.toDataURL('image/png'))
  } catch (error) {
    document.querySelector('#error').textContent = error.message
  } finally {
    busy = false
    render()
  }
}
document.querySelector('#confirm').onclick = () => output('copy')
document.querySelector('#save').onclick = () => output('save')
document.querySelector('#pin').onclick = () => output('pin')
textInput.addEventListener('compositionstart', () => {
  composingText = true
})
textInput.addEventListener('compositionend', () => {
  composingText = false
})
document.addEventListener('keydown', (event) => {
  // IME composition keys, including candidate-selection Enter and Escape, belong to the IME.
  if (event.isComposing || composingText || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (textAnchor) finishText(false)
    else api.close()
    return
  }
  // Keep native text editing shortcuts in the text field; Enter commits without exporting.
  if (event.target === textInput) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      finishText()
      canvas.focus()
    }
    return
  }
  // Editing the pixel value retains native selection/copy/paste; Enter commits without exporting.
  if (event.target === strokeInput) {
    if (event.key === 'Enter') {
      event.preventDefault()
      changeStyle(colorInput.value, strokeInput.value)
      canvas.focus()
      return
    }
    if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x'].includes(event.key.toLowerCase()))
      return
  }
  // Color/width controls retain native arrows, while common editor shortcuts work from them.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    document.querySelector('#whole').click()
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    document.querySelector(event.shiftKey ? '#redo' : '#undo').click()
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    document.querySelector('#redo').click()
  } else if (event.altKey && event.key.toLowerCase() === 'c') {
    // Alt+C to toggle color picker
    event.preventDefault()
    setTool(tool === 'picker' ? 'select' : 'picker')
  } else if (
    event.key === 'Enter' ||
    ((event.ctrlKey || event.metaKey) && ['c', 's', 't'].includes(event.key.toLowerCase()))
  ) {
    event.preventDefault()
    output(
      event.key.toLowerCase() === 's' ? 'save' : event.key.toLowerCase() === 't' ? 'pin' : 'copy'
    )
  } else if (
    crop &&
    tool === 'select' &&
    !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) &&
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
  ) {
    event.preventDefault()
    const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    const dy = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    crop.x = clamp(crop.x + dx, innerWidth - crop.width)
    crop.y = clamp(crop.y + dy, innerHeight - crop.height)
    render()
  }
})
window.addEventListener('resize', render)
setTool('select')
render()
// Publish readiness only after source pixels and all input handlers are available.
document.querySelector('#hint').textContent = '拖动选择区域 · 双击选区复制 · Esc 取消'
document.body.dataset.ready = 'true'
