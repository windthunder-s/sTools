/**
 * Validate a physical-pixel RGBA frame before inspecting it.
 * @param {object} frame Frame containing width, height and RGBA data.
 * @returns {boolean} Whether the frame is large enough and has a complete buffer.
 */
function validFrame(frame) {
  return Boolean(
    frame &&
    Number.isInteger(frame.width) &&
    Number.isInteger(frame.height) &&
    frame.width >= 16 &&
    frame.height >= 48 &&
    (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) &&
    frame.data.length === frame.width * frame.height * 4
  )
}

/**
 * Build a deterministic sample axis including its two ends.
 * @param {number} start Inclusive first coordinate.
 * @param {number} end Exclusive coordinate limit.
 * @param {number} limit Maximum number of coordinates.
 * @returns {number[]} Sample coordinates without duplicates.
 */
function sampleAxis(start, end, limit) {
  const count = Math.min(limit, end - start)
  if (count < 1) return []
  if (count === 1) return [start]
  return Array.from({ length: count }, (_, index) =>
    Math.round(start + (index * (end - start - 1)) / (count - 1))
  )
}

/**
 * Measure RGB disagreement between two selected image rows.
 * @param {object} first First RGBA frame.
 * @param {number} firstY Row in the first frame.
 * @param {object} second Second RGBA frame.
 * @param {number} secondY Row in the second frame.
 * @param {number[]} columns Horizontal sample coordinates.
 * @returns {{error:number, mismatch:number}} Mean channel error and fraction of changed pixels.
 */
function compareRow(first, firstY, second, secondY, columns) {
  let error = 0
  let mismatch = 0
  for (const x of columns) {
    const a = (firstY * first.width + x) * 4
    const b = (secondY * second.width + x) * 4
    const dr = Math.abs(first.data[a] - second.data[b])
    const dg = Math.abs(first.data[a + 1] - second.data[b + 1])
    const db = Math.abs(first.data[a + 2] - second.data[b + 2])
    error += (dr + dg + db) / 3
    if (Math.max(dr, dg, db) > 8) mismatch++
  }
  return { error: error / columns.length, mismatch: mismatch / columns.length }
}

/**
 * Compare every stationary frame pixel so narrow animated regions cannot fall between samples.
 * @param {object} first First RGBA frame.
 * @param {object} second Second RGBA frame.
 * @returns {{error:number,mismatch:number,rows:object[]}} Stationary frame differences.
 */
function stationaryDifference(first, second) {
  const columns = sampleAxis(0, first.width, first.width)
  const rows = Array.from({ length: first.height }, (_, y) =>
    compareRow(first, y, second, y, columns)
  )
  return {
    error: rows.reduce((sum, row) => sum + row.error, 0) / rows.length,
    mismatch: rows.reduce((sum, row) => sum + row.mismatch, 0) / rows.length,
    rows
  }
}

/**
 * Confirm that two captures are visually stationary before attempting a stitch.
 * @param {object} first RGBA frame captured after scrolling.
 * @param {object} second A later confirmation frame from the same selection.
 * @returns {{stable:boolean,status:string,error:number,mismatch:number}} Stability assessment.
 */
export function assessStableFrames(first, second) {
  if (
    !validFrame(first) ||
    !validFrame(second) ||
    first.width !== second.width ||
    first.height !== second.height
  ) {
    return { stable: false, status: 'invalid-input', error: Infinity, mismatch: 1 }
  }
  const difference = stationaryDifference(first, second)
  const stable = difference.error <= 0.3 && difference.mismatch === 0
  return {
    stable,
    status: stable ? 'stable' : 'unstable',
    error: difference.error,
    mismatch: difference.mismatch
  }
}

/**
 * Reject uniform areas that cannot anchor a trustworthy vertical displacement.
 * @param {object} frame RGBA image to measure.
 * @returns {number} Mean RGB variation between neighboring vertical samples.
 */
function verticalTexture(frame) {
  const columns = sampleAxis(0, frame.width, 64)
  const rows = sampleAxis(0, frame.height - 1, 96)
  return (
    rows.reduce((sum, y) => sum + compareRow(frame, y, frame, y + 1, columns).error, 0) /
    rows.length
  )
}

/**
 * Search every integer vertical displacement within the permitted overlap range.
 * @param {object} previous Previously accepted viewport.
 * @param {object} current New viewport.
 * @param {number} maximumDelta Largest positive or negative displacement.
 * @returns {object[]} Candidates sorted by their central overlap error.
 */
function scoreDisplacements(previous, current, maximumDelta) {
  const columns = sampleAxis(0, previous.width, 80)
  const trim = Math.floor(previous.height * 0.12)
  const candidates = []
  for (let delta = -maximumDelta; delta <= maximumDelta; delta++) {
    // Ignore small edge overlays for discovery only; acceptance checks the full overlap later.
    const start = Math.max(trim, trim - delta)
    const end = Math.min(current.height - trim, previous.height - trim - delta)
    if (end - start < Math.max(12, Math.floor(previous.height * 0.08))) continue
    const rows = sampleAxis(start, end, 48)
    const error =
      rows.reduce((sum, y) => sum + compareRow(previous, y + delta, current, y, columns).error, 0) /
      rows.length
    candidates.push({ delta, error })
  }
  return candidates.sort((a, b) => a.error - b.error || Math.abs(a.delta) - Math.abs(b.delta))
}

/**
 * Find stationary edge bands inconsistent with the detected content movement.
 * @param {object} previous Previously accepted viewport.
 * @param {object} current New viewport.
 * @param {number} delta Candidate vertical displacement.
 * @param {object[]} stationaryRows Per-row differences with no displacement.
 * @returns {{top:number,bottom:number}} Height of strongly evidenced fixed edge bands.
 */
function detectFixedEdges(previous, current, delta, stationaryRows) {
  const columns = sampleAxis(0, previous.width, previous.width)
  const edgeLimit = Math.floor(previous.height * 0.25)
  const fixed = { top: 0, bottom: 0 }
  for (const edge of ['top', 'bottom']) {
    let stationaryCount = 0
    let inconsistentCount = 0
    for (let offset = 0; offset < edgeLimit; offset++) {
      const y = edge === 'top' ? offset : previous.height - 1 - offset
      const still = stationaryRows[y]
      if (still.error > 0.5 || still.mismatch > 0.005) break
      stationaryCount++
      // The inverse comparison also covers footers outside the current overlap.
      let shifted
      if (y + delta >= 0 && y + delta < previous.height)
        shifted = compareRow(previous, y + delta, current, y, columns)
      else if (y - delta >= 0 && y - delta < current.height)
        shifted = compareRow(previous, y, current, y - delta, columns)
      if (shifted && shifted.error > 3 && shifted.mismatch > 0.03) inconsistentCount++
    }
    if (stationaryCount >= 2 && inconsistentCount >= Math.max(2, stationaryCount * 0.1))
      fixed[edge] = stationaryCount
  }
  return fixed
}

/**
 * Produce a safe append plan from two stable, equally sized vertical viewports.
 * @param {object} previous Last accepted physical-pixel RGBA viewport.
 * @param {object} current Candidate RGBA viewport after manual downward scrolling.
 * @param {object} confirmation Later capture confirming the current viewport has settled.
 * @param {object} options Configuration; minimumOverlapRatio defaults to 0.4 and may only increase.
 * @returns {object} Status, signed delta, conservative confidence and optional append region.
 */
export function planVerticalAppend(previous, current, confirmation, options = {}) {
  const rejected = { status: 'invalid-input', delta: 0, confidence: 0, append: null }
  if (
    !validFrame(previous) ||
    !validFrame(current) ||
    previous.width !== current.width ||
    previous.height !== current.height
  )
    return rejected

  // Never compare a moving/animated candidate to the accumulated capture.
  const stability = assessStableFrames(current, confirmation)
  if (!stability.stable) return { ...rejected, status: stability.status, stability }
  const stationary = stationaryDifference(previous, current)
  if (stationary.error <= 0.3 && stationary.mismatch <= 0.001)
    return { ...rejected, status: 'duplicate', confidence: 1 }

  const texture = Math.min(verticalTexture(previous), verticalTexture(current))
  if (texture < 1.5) return { ...rejected, status: 'low-texture', texture }
  const minimumOverlapRatio = Math.max(
    0.4,
    Math.min(0.9, Number(options.minimumOverlapRatio) || 0.4)
  )
  const maximumDelta = Math.floor(previous.height * (1 - minimumOverlapRatio))
  const candidates = scoreDisplacements(previous, current, maximumDelta)
  const best = candidates[0]
  if (!best || best.error > 3)
    return { ...rejected, status: 'no-overlap', matchError: best?.error ?? Infinity }
  const rival = candidates.find((candidate) => Math.abs(candidate.delta - best.delta) > 2)
  const margin = rival ? rival.error - best.error : Infinity
  if (margin < 1.2)
    return { ...rejected, status: 'ambiguous', delta: best.delta, matchError: best.error, margin }
  if (best.delta === 0) return { ...rejected, status: 'content-changed', matchError: best.error }

  const fixedEdges = detectFixedEdges(previous, current, best.delta, stationary.rows)
  if (fixedEdges.top || fixedEdges.bottom)
    return { ...rejected, status: 'fixed-overlay', delta: best.delta, fixedEdges }

  // Verify every overlapping pixel. Native screen frames need no lossy-image allowance;
  // changes exceeding 8 RGB levels must not be hidden by a whole-frame average.
  const columns = sampleAxis(0, previous.width, previous.width)
  const start = Math.max(0, -best.delta)
  const end = Math.min(current.height, previous.height - best.delta)
  const overlapRows = Array.from({ length: end - start }, (_, index) =>
    compareRow(previous, start + index + best.delta, current, start + index, columns)
  )
  const error = overlapRows.reduce((sum, row) => sum + row.error, 0) / overlapRows.length
  const mismatch = overlapRows.reduce((sum, row) => sum + row.mismatch, 0) / overlapRows.length
  const badRowRatio =
    overlapRows.filter((row) => row.error > 3 || row.mismatch > 0.03).length / overlapRows.length
  if (error > 1.5 || mismatch > 0 || badRowRatio > 0.01)
    return {
      ...rejected,
      status: 'content-changed',
      delta: best.delta,
      matchError: error,
      mismatch,
      badRowRatio
    }
  const confidence = Math.max(0, Math.min(1, 1 - error / 6, margin / 8, 1 - mismatch * 20))
  if (best.delta < 0) return { ...rejected, status: 'upward', delta: best.delta, confidence }
  return {
    status: 'append',
    delta: best.delta,
    confidence,
    overlap: { previousY: best.delta, currentY: 0, height: previous.height - best.delta },
    append: { x: 0, y: current.height - best.delta, width: current.width, height: best.delta },
    matchError: error,
    mismatch,
    margin
  }
}
