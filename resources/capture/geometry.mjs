/**
 * Clamp a coordinate to the selected display.
 * @param {number} value Coordinate.
 * @param {number} maximum Display limit.
 * @returns {number} Clamped finite value.
 */
export function clamp(value, maximum) {
  return Math.max(0, Math.min(maximum, Number.isFinite(value) ? value : 0))
}
/**
 * Normalize dragging in either direction without leaving the source image.
 * @param {object} start Initial point.
 * @param {object} end Current point.
 * @param {number} width Display width.
 * @param {number} height Display height.
 * @returns {object} Positive selection rectangle.
 */
export function rectangle(start, end, width, height) {
  const x1 = clamp(start.x, width),
    y1 = clamp(start.y, height),
    x2 = clamp(end.x, width),
    y2 = clamp(end.y, height)
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  }
}
/**
 * Convert DIP selection coordinates to bounded physical pixels for mixed-DPI displays.
 * @param {object} crop Display-relative selection.
 * @param {number} sourceWidth Captured frame width.
 * @param {number} sourceHeight Captured frame height.
 * @param {number} displayWidth Display DIP width.
 * @param {number} displayHeight Display DIP height.
 * @returns {object} Source pixel rectangle.
 */
export function pixels(crop, sourceWidth, sourceHeight, displayWidth, displayHeight) {
  const x = Math.floor(clamp((crop.x / displayWidth) * sourceWidth, sourceWidth - 1)),
    y = Math.floor(clamp((crop.y / displayHeight) * sourceHeight, sourceHeight - 1))
  return {
    x,
    y,
    width: Math.max(
      1,
      Math.min(sourceWidth - x, Math.round((crop.width / displayWidth) * sourceWidth))
    ),
    height: Math.max(
      1,
      Math.min(sourceHeight - y, Math.round((crop.height / displayHeight) * sourceHeight))
    )
  }
}

/**
 * Locate all eight selection resize handles.
 * @param {object} crop Selection in display coordinates.
 * @returns {Array<object>} Handles with direction and position.
 */
export function handles(crop) {
  return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((name) => ({
    name,
    x: crop.x + (name.includes('w') ? 0 : name.includes('e') ? crop.width : crop.width / 2),
    y: crop.y + (name.includes('n') ? 0 : name.includes('s') ? crop.height : crop.height / 2)
  }))
}

/**
 * Resize from an edge or corner, retaining the opposite edge even when crossed.
 * @param {object} crop Original selection.
 * @param {string} handle Handle direction.
 * @param {object} point Current pointer position.
 * @param {number} width Display width.
 * @param {number} height Display height.
 * @returns {object} Bounded positive rectangle.
 */
export function resize(crop, handle, point, width, height) {
  return rectangle(
    { x: handle.includes('w') ? point.x : crop.x, y: handle.includes('n') ? point.y : crop.y },
    {
      x: handle.includes('e') ? point.x : crop.x + crop.width,
      y: handle.includes('s') ? point.y : crop.y + crop.height
    },
    width,
    height
  )
}

/**
 * Place the toolbar next to a selection and keep every action on screen.
 * @param {object} crop Selection rectangle.
 * @param {object} size Measured toolbar width and height.
 * @param {number} width Viewport width.
 * @param {number} height Viewport height.
 * @returns {object} Toolbar position and whether it is above the selection.
 */
export function toolbarPosition(crop, size, width, height) {
  const gap = 10,
    margin = 6
  const below = crop.y + crop.height + gap
  const above = crop.y - size.height - gap
  const flip = below + size.height > height - margin && above >= margin
  return {
    x: Math.max(margin, Math.min(crop.x + crop.width - size.width, width - size.width - margin)),
    y: Math.max(margin, Math.min(flip ? above : below, height - size.height - margin)),
    above: flip
  }
}
