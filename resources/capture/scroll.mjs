import { assessStableFrames, planVerticalAppend } from './vertical-stitch.mjs'
const api = window.capture
const status = document.querySelector('#scroll-status'),
  error = document.querySelector('#scroll-error')
const result = document.createElement('canvas'),
  resultContext = result.getContext('2d')
let phase = 'idle',
  baseline,
  pending,
  timer,
  running = false,
  exporting = false,
  acceptedURL = '',
  segments = 0
const messages = {
  duplicate: '画面未变化，继续向下滚动。',
  upward: '检测到向上滚动，未追加。请回到上次位置后向下滚动。',
  unstable: '画面仍在变化，等待停止滚动或动画结束…',
  'fixed-overlay': '选区含固定栏，无法可靠拼接。请重新只框选可滚动正文。',
  'no-overlap': '滚动过多或页面变化，未追加。请向上退回一些，再缓慢向下滚动。',
  'low-texture': '当前内容特征不足，未追加。可略微滚动，或重新扩大正文选区。',
  ambiguous: '重复内容无法定位，未追加。请略微滚动后等待。',
  'content-changed': '页面内容变化，未追加。请等待稳定或返回上次位置。'
}

/**
 * Decode one host-owned selection frame into lossless physical pixels.
 * @returns {Promise<object>} RGBA pixels and a drawable canvas.
 * @throws {Error} If capture or image decoding fails.
 */
async function frame() {
  const image = new Image()
  image.src = await api.scrollFrame()
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0)
  return {
    width: canvas.width,
    height: canvas.height,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas
  }
}

/**
 * Refresh the preview at the output's native pixel dimensions without resampling stored pixels.
 * @returns {void} No value.
 */
function preview() {
  document.querySelector('#captured-count').textContent = String(segments)
  document.querySelector('#total-height').textContent = String(result.height)
  document.querySelector('#stop-scroll').disabled = false
}

/**
 * Validate a candidate before changing the last exportable image.
 * @param {HTMLCanvasElement} candidate Native-resolution candidate image.
 * @returns {string|null} Encoded PNG within the host's limits, or null on the size limit.
 * @throws {Error} If the browser cannot encode the canvas.
 */
function encodeCandidate(candidate) {
  if (
    candidate.width > 16384 ||
    candidate.height > 16384 ||
    candidate.width * candidate.height > 40000000
  )
    return null
  const encoded = candidate.toDataURL('image/png')
  if (!encoded.startsWith('data:image/png;base64,')) throw Error('长图编码失败，请保存已有内容。')
  return encoded.length <= 64 * 1024 * 1024 ? encoded : null
}

/**
 * Append only a verified new strip and enforce output limits before allocating the expanded image.
 * @param {object} next Stable frame with a canvas.
 * @param {number} delta Number of new bottom rows.
 * @returns {boolean} Whether the frame was appended within limits.
 */
function append(next, delta) {
  const height = result.height + delta
  if (height > 16384 || result.width * height > 40000000) {
    status.textContent = '已到长图尺寸上限，请完成并保存。'
    return false
  }
  // Stage and encode the candidate first; a failed append must preserve the accepted output.
  const candidate = document.createElement('canvas')
  candidate.width = result.width
  candidate.height = height
  const context = candidate.getContext('2d')
  context.drawImage(result, 0, 0)
  context.drawImage(
    next.canvas,
    0,
    next.height - delta,
    next.width,
    delta,
    0,
    result.height,
    next.width,
    delta
  )
  const encoded = encodeCandidate(candidate)
  if (!encoded) {
    status.textContent = '已到长图尺寸或文件大小上限，请完成并保存已有内容。'
    return false
  }
  // Publish pixels and their validated encoding together only after all limits pass.
  result.height = height
  resultContext.drawImage(candidate, 0, 0)
  acceptedURL = encoded
  segments++
  preview()
  return true
}

/**
 * Capture serially and require two stable frames before accepting each new portion.
 * @returns {Promise<void>} One capture/check cycle.
 */
async function tick() {
  if (running || phase !== 'capturing') return
  running = true
  try {
    const next = await frame()
    if (phase !== 'capturing') return
    if (!pending) {
      pending = next
      return
    }
    if (!baseline) {
      if (!assessStableFrames(pending, next).stable) {
        pending = next
        status.textContent = messages.unstable
        return
      }
      const encoded = encodeCandidate(next.canvas)
      if (!encoded) throw Error('选区图像超过输出上限，请缩小选区后重试。')
      baseline = next
      result.width = next.width
      result.height = next.height
      resultContext.drawImage(next.canvas, 0, 0)
      acceptedURL = encoded
      segments = 1
      preview()
      status.textContent = '已就绪，请在选区内向下滚动。'
    } else {
      const plan = planVerticalAppend(baseline, pending, next)
      if (plan.status === 'append') {
        if (!append(pending, plan.delta)) {
          phase = 'limit'
          clearInterval(timer)
          return
        }
        baseline = pending
        status.textContent = `已拼接 ${segments} 段，可继续向下滚动。`
      } else status.textContent = messages[plan.status] || '当前画面无法可靠拼接，未追加。'
    }
    pending = next
  } catch (failure) {
    if (phase !== 'capturing') return
    status.textContent = '采集暂停，请完成已有内容或重新开始。'
    error.textContent = failure.message
    phase = 'error'
    clearInterval(timer)
  } finally {
    running = false
  }
}

/**
 * Stop acquisition and freeze the last verified output for explicit copy/save/pin.
 * @returns {Promise<void>} Completion after host session transition.
 */
async function finish() {
  if (!baseline || !['capturing', 'paused', 'error', 'limit'].includes(phase)) return
  // Claim completion before awaiting IPC so repeated clicks and Enter cannot race it.
  phase = 'finishing'
  document.querySelector('#stop-scroll').disabled = true
  clearInterval(timer)
  try {
    await api.scrollFinish()
    phase = 'done'
    document.querySelector('#control-panel').hidden = true
    document.querySelector('#preview-panel').hidden = false
    const canvas = document.querySelector('#preview-canvas')
    canvas.width = result.width
    canvas.height = result.height
    canvas.getContext('2d').drawImage(result, 0, 0)
    document.querySelector('#preview-size').textContent = `${result.width} × ${result.height} px`
    document.querySelector('#preview-segments').textContent = String(segments)
    document.body.dataset.phase = phase
    status.textContent = `长截图完成，共 ${segments} 段。`
  } catch (failure) {
    phase = 'error'
    document.querySelector('#stop-scroll').disabled = false
    error.textContent = failure.message
  }
}

/**
 * Export the verified native-resolution composite through the owned PNG output API.
 * @param {string} action Copy, save or pin.
 * @returns {Promise<void>} Export completion, with errors shown in the window.
 */
async function output(action) {
  if (phase !== 'done' || exporting) return
  exporting = true
  const buttons = ['copy-long-screenshot', 'save-long-screenshot', 'retry-scroll'].map((id) =>
    document.querySelector('#' + id)
  )
  for (const button of buttons) button.disabled = true
  error.textContent = ''
  try {
    await api.image(action, acceptedURL)
  } catch (failure) {
    error.textContent = failure.message
  } finally {
    // A canceled save dialog keeps the completed image available for another output action.
    exporting = false
    for (const button of buttons) button.disabled = false
  }
}
/**
 * Start or retry sampling the same owned region without scrolling the control window.
 * @returns {Promise<void>} Sampling initialization completion.
 */
async function start() {
  if (!['idle', 'done'].includes(phase) || exporting) return
  const previous = phase
  phase = 'starting'
  try {
    if (previous === 'done') await api.scrollRetry()
    clearInterval(timer)
    baseline = pending = undefined
    acceptedURL = ''
    segments = 0
    error.textContent = ''
    document.querySelector('#captured-count').textContent = '0'
    document.querySelector('#total-height').textContent = '0'
    document.querySelector('#preview-panel').hidden = true
    document.querySelector('#control-panel').hidden = false
    document.querySelector('#start-scroll').disabled = true
    document.querySelector('#pause-scroll').disabled = false
    document.querySelector('#stop-scroll').disabled = true
    document.querySelector('#pause-scroll').textContent = '暂停'
    phase = 'capturing'
    document.body.dataset.phase = phase
    status.textContent = '正在等待选区画面稳定，请稍候。'
    await tick()
    timer = setInterval(tick, 350)
  } catch (failure) {
    phase = previous
    error.textContent = failure.message
  }
}

/**
 * Pause or resume capture while keeping the last verified overlap reference.
 * @returns {void} No value.
 */
function togglePause() {
  if (phase === 'capturing') {
    phase = 'paused'
    status.textContent = '采集已暂停，可完成已有内容。'
  } else if (phase === 'paused') {
    phase = 'capturing'
    pending = undefined
    status.textContent = '继续采集，请等待画面稳定。'
  }
  document.querySelector('#pause-scroll').textContent = phase === 'paused' ? '继续' : '暂停'
  document.body.dataset.phase = phase
}

document.querySelector('#start-scroll').onclick = start
document.querySelector('#pause-scroll').onclick = togglePause
document.querySelector('#stop-scroll').onclick = finish
document.querySelector('#copy-long-screenshot').onclick = () => output('copy')
document.querySelector('#save-long-screenshot').onclick = () => output('save')
document.querySelector('#retry-scroll').onclick = start
document.querySelector('#close-panel').onclick = () => api.close()
document.querySelector('#close-preview').onclick = () => api.close()
document.querySelector('#scroll-mode').value = 'manual'
document.querySelector('#scroll-mode option[value=auto]').disabled = true
document.querySelector('#speed-control').hidden = true
document.querySelector('#remove-fixed-header').checked = false
document.querySelector('#remove-fixed-header').disabled = true
document.querySelector('#remove-fixed-header').closest('label').title = '请框选不含固定栏的正文'
document.querySelector('#edit-long-screenshot').disabled = true
document.querySelector('#edit-long-screenshot').title = '长图编辑暂未支持'
status.textContent = '点击开始后，在原应用中手动向下滚动；每次不超过选区一半，并等待画面稳定。'
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close()
  else if (event.key === 'Enter') {
    event.preventDefault()
    if (phase === 'done') void output('copy')
    else void finish()
  }
})
window.addEventListener('unload', () => {
  phase = 'closed'
  clearInterval(timer)
})
document.body.dataset.phase = phase
document.body.dataset.ready = 'true'
