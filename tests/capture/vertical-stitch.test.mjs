import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessStableFrames, planVerticalAppend } from '../../resources/capture/vertical-stitch.mjs'

/**
 * Hash coordinates into reproducible synthetic image detail.
 * @param {number} value Input integer.
 * @returns {number} Deterministic byte.
 */
function hash(value) {
  let mixed = Math.imul(value ^ 0x45d9f3b, 0x45d9f3b)
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b)
  return (mixed ^ (mixed >>> 16)) & 255
}

/**
 * Generate an artificial document without reading any screen or file.
 * @param {number} width Document width.
 * @param {number} height Document height.
 * @param {string} mode Pixel pattern: texture, document, stripes or flat.
 * @returns {object} RGBA fixture.
 */
function makeImage(width = 128, height = 1600, mode = 'texture') {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      let red = hash(y * 3719 + x * 421)
      let green = hash(y * 421 + x * 151)
      let blue = hash(y * 71 + x * 919)
      if (mode === 'document') {
        const glyph = x > 6 && x < width - 6 && y % 17 < 11 && x % 8 < 6 && hash(Math.floor(y / 17) * 99 + Math.floor(x / 8)) > 75
        red = green = blue = glyph ? (hash(y * 13 + Math.floor(x / 8)) < 64 ? 110 : 28) : 248
      }
      if (mode === 'stripes') red = green = blue = (y % 20 < 10 ? 230 : 25)
      if (mode === 'flat') red = green = blue = 245
      data.set([red, green, blue, 255], offset)
    }
  }
  return { width, height, data }
}

/**
 * Take an unmodified viewport from a generated document.
 * @param {object} document Source image.
 * @param {number} start Starting document row.
 * @param {number} height Viewport height.
 * @returns {object} Independent RGBA viewport.
 */
function viewport(document, start, height = 200) {
  return { width: document.width, height, data: document.data.slice(start * document.width * 4, (start + height) * document.width * 4) }
}

/**
 * Clone a viewport to represent a second capture after the viewport settles.
 * @param {object} frame Input RGBA image.
 * @returns {object} Independent copy.
 */
function clone(frame) {
  return { ...frame, data: frame.data.slice() }
}

/**
 * Insert a generated rectangle representing an overlay or animated region.
 * @param {object} frame Frame to mutate.
 * @param {number} x Rectangle left.
 * @param {number} y Rectangle top.
 * @param {number} width Rectangle width.
 * @param {number} height Rectangle height.
 * @param {number} seed Different synthetic content seed.
 * @returns {object} Mutated frame.
 */
function paint(frame, x, y, width, height, seed) {
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      const offset = (py * frame.width + px) * 4
      frame.data.set([hash(seed + py * 111 + px), hash(seed + py + px * 41), hash(seed + px * 55), 255], offset)
    }
  }
  return frame
}

/**
 * Run the match with an independent identical stability confirmation.
 * @param {object} previous Last viewport.
 * @param {object} current New viewport.
 * @returns {object} Stitch plan.
 */
function plan(previous, current) {
  return planVerticalAppend(previous, current, clone(current))
}

const document = makeImage()

test('stable captures and exact duplicates append no pixels', () => {
  const frame = viewport(document, 300)
  assert.equal(assessStableFrames(frame, clone(frame)).stable, true)
  const result = plan(frame, clone(frame))
  assert.equal(result.status, 'duplicate')
  assert.equal(result.append, null)
})

for (const delta of [1, 7, 39, 80, 119, 120]) {
  test(`downward movement ${delta} produces the exact append interval`, () => {
    const previous = viewport(document, 200)
    const current = viewport(document, 200 + delta)
    const result = plan(previous, current)
    assert.equal(result.status, 'append', JSON.stringify(result))
    assert.equal(result.delta, delta)
    assert.ok(result.confidence > 0.9)
    assert.deepEqual(result.append, { x: 0, y: 200 - delta, width: 128, height: delta })
  })
}

test('several accepted scrolls reconstruct every original document pixel once', () => {
  let previous = viewport(document, 200)
  let accumulated = previous.data.slice()
  let offset = 200
  for (const delta of [30, 76, 49, 110, 22, 95]) {
    offset += delta
    const current = viewport(document, offset)
    const result = plan(previous, current)
    assert.equal(result.status, 'append')
    const addition = current.data.slice(result.append.y * current.width * 4)
    const next = new Uint8ClampedArray(accumulated.length + addition.length)
    next.set(accumulated)
    next.set(addition, accumulated.length)
    accumulated = next
    previous = current
  }
  assert.deepEqual(accumulated, document.data.slice(200 * 128 * 4, (offset + 200) * 128 * 4))
})

test('upward movement is identified and never appended', () => {
  const result = plan(viewport(document, 300), viewport(document, 250))
  assert.equal(result.status, 'upward')
  assert.equal(result.delta, -50)
  assert.equal(result.append, null)
})

test('jump exceeding 60 percent of the viewport is rejected', () => {
  const result = plan(viewport(document, 200), viewport(document, 340))
  assert.equal(result.status, 'no-overlap')
  assert.equal(result.append, null)
})

test('unrelated pages are rejected', () => {
  const result = plan(viewport(document, 200), viewport(document, 900))
  assert.equal(result.status, 'no-overlap')
  assert.equal(result.append, null)
})

test('changing cursor-sized or animated content blocks stability', () => {
  const previous = viewport(document, 200)
  const current = viewport(document, 260)
  const moving = paint(clone(current), 40, 60, 10, 12, 133)
  const result = planVerticalAppend(previous, current, moving)
  assert.equal(result.status, 'unstable')
  assert.equal(result.append, null)
})

test('content changed between accepted pages is rejected even after settling', () => {
  const current = paint(viewport(document, 260), 40, 50, 10, 10, 133)
  const result = plan(viewport(document, 200), current)
  assert.equal(result.status, 'content-changed', JSON.stringify(result))
  assert.equal(result.append, null)
})

for (const position of ['top', 'bottom', 'both']) {
  test(`fixed ${position} toolbar is explicitly detected and rejected`, () => {
    const previous = viewport(document, 200)
    const current = viewport(document, 260)
    if (position !== 'bottom') {
      paint(previous, 0, 0, 128, 20, 31)
      paint(current, 0, 0, 128, 20, 31)
    }
    if (position !== 'top') {
      paint(previous, 0, 180, 128, 20, 53)
      paint(current, 0, 180, 128, 20, 53)
    }
    const result = plan(previous, current)
    assert.equal(result.status, 'fixed-overlay', JSON.stringify(result))
    assert.equal(result.append, null)
    if (position !== 'bottom') assert.equal(result.fixedEdges.top, 20)
    if (position !== 'top') assert.equal(result.fixedEdges.bottom, 20)
  })
}

test('uniform and nearly uniform images cannot establish a scroll offset', () => {
  const previous = viewport(makeImage(128, 400, 'flat'), 0)
  const current = clone(previous)
  for (let offset = 0; offset < current.data.length; offset += 4) current.data[offset] -= 10
  const result = plan(previous, current)
  assert.equal(result.status, 'low-texture')
  assert.equal(result.append, null)
})

test('repeated horizontal bands cannot establish an unambiguous scroll offset', () => {
  const repeated = makeImage(128, 600, 'stripes')
  const result = plan(viewport(repeated, 100), viewport(repeated, 107))
  assert.equal(result.status, 'ambiguous', JSON.stringify(result))
  assert.equal(result.append, null)
})

test('synthetic black-and-white document with blank margins is matched', () => {
  const page = makeImage(128, 1000, 'document')
  const result = plan(viewport(page, 130), viewport(page, 210))
  assert.equal(result.status, 'append', JSON.stringify(result))
  assert.equal(result.delta, 80)
})

test('small RGB rounding differences preserve a unique displacement', () => {
  const current = viewport(document, 260)
  for (let i = 0; i < current.data.length; i += 4) {
    current.data[i] = Math.min(255, current.data[i] + 1)
    current.data[i + 1] = Math.max(0, current.data[i + 1] - 1)
  }
  const result = plan(viewport(document, 200), current)
  assert.equal(result.status, 'append', JSON.stringify(result))
  assert.equal(result.delta, 60)
})

test('different viewport sizes, missing confirmations and incomplete buffers are rejected', () => {
  const previous = viewport(document, 200)
  assert.equal(planVerticalAppend(previous, viewport(document, 250, 190), clone(previous)).status, 'invalid-input')
  assert.equal(planVerticalAppend(previous, clone(previous), undefined).status, 'invalid-input')
  assert.equal(plan({ ...previous, data: previous.data.slice(1) }, previous).status, 'invalid-input')
})

test('a stricter overlap option rejects a movement requiring too little overlap', () => {
  const previous = viewport(document, 200)
  const current = viewport(document, 280)
  const result = planVerticalAppend(previous, current, clone(current), { minimumOverlapRatio: 0.7 })
  assert.equal(result.status, 'no-overlap')
})

test('one animated pixel is detected on a large viewport without a sampling blind spot', () => {
  const first = makeImage(1600, 900)
  const second = paint(clone(first), 11, 511, 1, 1, 9127)
  assert.equal(assessStableFrames(first, second).stable, false)
})

test('a wide viewport still rejects a narrow changed vertical strip', () => {
  const wideDocument = makeImage(1600, 600)
  const previous = viewport(wideDocument, 100)
  const current = paint(viewport(wideDocument, 160), 11, 0, 2, 140, 173)
  const result = plan(previous, current)
  // A two-pixel strip is below the accepted overlap noise budget, so require the seam safety check too.
  assert.notEqual(result.status, 'append', JSON.stringify(result))
})

test('a deterministic range of document offsets and signed deltas stays exact', () => {
  for (let index = 0; index < 30; index++) {
    const offset = 180 + index * 27
    const delta = (hash(index + 1029) % 239) - 119 || 1
    const result = plan(viewport(document, offset), viewport(document, offset + delta))
    assert.equal(result.delta, delta, JSON.stringify({ index, result }))
    assert.equal(result.status, delta > 0 ? 'append' : 'upward', JSON.stringify({ index, result }))
  }
})

test('full HD physical pixels retain exact overlap and append dimensions', () => {
  const fullDocument = makeImage(1920, 1800)
  const previous = viewport(fullDocument, 0, 1080)
  const current = viewport(fullDocument, 432, 1080)
  const started = performance.now()
  const result = plan(previous, current)
  const elapsed = Math.round(performance.now() - started)
  assert.equal(result.status, 'append', JSON.stringify(result))
  assert.equal(result.delta, 432)
  assert.deepEqual(result.append, { x: 0, y: 648, width: 1920, height: 432 })
  process.stdout.write(`Full HD matcher: ${elapsed} ms (informational, no timing assertion)\n`)
})
