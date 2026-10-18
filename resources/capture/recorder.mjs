import { pixels } from './geometry.mjs'
const api = window.capture,
  info = await api.describe(),
  isGif = info.kind === 'gif',
  canvas = document.createElement('canvas'),
  ctx = canvas.getContext('2d', { willReadFrequently: isGif })
const stateLabel = document.querySelector('#record-state'),
  errorLabel = document.querySelector('#prepare-error'),
  startButton = document.querySelector('#start-record'),
  stopButton = document.querySelector('#stop-btn'),
  pauseButton = document.querySelector('#pause-btn'),
  saveButton = document.querySelector('#save-file-btn'),
  systemAudioInput = document.querySelector('#enable-system-audio'),
  microphoneInput = document.querySelector('#enable-microphone')
let phase = 'ready',
  active = null

/**
 * Reflect the host recording lifecycle in the replacement preparation and playback panels.
 * @param {string} next New recorder phase.
 * @returns {void} No value.
 */
function setPhase(next) {
  phase = next
  const preparing = ['preparing', 'countdown', 'recording', 'paused', 'finalizing'].includes(phase)
  document.querySelector('#prepare-panel').hidden = !['ready', 'error'].includes(phase)
  document.querySelector('#top-control-bar').hidden = !preparing
  document.querySelector('#countdown-overlay').hidden = phase !== 'countdown'
  document.querySelector('#save-dialog').hidden = phase !== 'done'
  document.querySelector('#resume-btn').hidden = phase !== 'paused'
  pauseButton.hidden = phase !== 'recording'
  document.querySelector('#quality-select').disabled = phase !== 'ready'
  document.body.dataset.phase = phase
}

document.querySelector('#record-title').textContent = isGif ? 'sTools GIF 录制' : 'sTools 区域录屏'
for (const input of [systemAudioInput, microphoneInput]) input.closest('label').hidden = isGif
systemAudioInput.checked = !isGif && info.systemAudio
microphoneInput.checked = !isGif && info.microphone

/**
 * Refresh the recording summary from options accepted by the owning main-process session.
 * @returns {void} No value.
 */
function updateDetails() {
  document.querySelector('#record-details').textContent =
    `${Math.round(info.crop.width)} × ${Math.round(info.crop.height)} · ${isGif ? 'GIF · 最长 30 秒 · 最大宽度 720 px' : 'MP4 优先 · 最长 30 分钟 / 512 MB'}${info.systemAudio ? ' · 系统声音' : ''}${info.microphone ? ' · 麦克风' : ''}`
}

/**
 * Persist the ready session's explicit audio choices before requesting any device access.
 * @returns {Promise<void>} Completion after the host validates the options.
 * @throws If options cannot be changed in the current session state.
 */
async function saveOptions() {
  const accepted = await api.options({
    microphone: !isGif && microphoneInput.checked,
    systemAudio: !isGif && systemAudioInput.checked
  })
  info.microphone = accepted.microphone
  info.systemAudio = accepted.systemAudio
  updateDetails()
}

/**
 * Stop resources belonging only to this attempt, including streams returned after cancellation.
 * @param {object} run Recording attempt whose resources must be released.
 * @returns {void} No value.
 */
function release(run) {
  if (!run) return
  clearInterval(run.timer)
  for (const media of [run.stream, run.microphone, run.output])
    media?.getTracks().forEach((track) => track.stop())
  if (run.mixer && run.mixer.state !== 'closed') void run.mixer.close().catch(() => {})
  if (run.video) run.video.srcObject = null
  run.worker?.terminate()
}

/**
 * Reject continuations from cancelled or superseded asynchronous recording attempts.
 * @param {object} run Attempt being resumed after an await.
 * @returns {void} No value.
 * @throws If the attempt was cancelled, stopped or replaced.
 */
function assertActive(run) {
  if (active !== run || run.cancelled || run.stopping) throw Error('录制已取消')
}

/**
 * Restore an empty session for retry while preserving the selected region and audio choices.
 * @param {object} run Attempt being reset.
 * @param {string} message Optional failure reason to retain for the user.
 * @returns {void} No value.
 */
function resetReady(run, message = '') {
  if (active !== run) return
  release(run)
  active = null
  setPhase('ready')
  stateLabel.textContent = '准备就绪'
  errorLabel.textContent = message
  document.querySelector('#record-time').textContent = '00:00'
  startButton.disabled = false
  stopButton.disabled = pauseButton.disabled = saveButton.disabled = true
  stopButton.textContent = '停止'
  pauseButton.textContent = '暂停'
  systemAudioInput.disabled = microphoneInput.disabled = false
}

/**
 * Serialize encoded chunks and retain failures so finalization cannot silently claim success.
 * @param {object} run Attempt that owns the encoded data.
 * @param {Blob|Uint8Array} chunk Encoded media bytes.
 * @returns {void} No value.
 */
function queue(run, chunk) {
  run.writeChain = run.writeChain
    .then(async () => {
      const data = chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk
      for (let i = 0; i < data.length; i += 8 * 1024 * 1024)
        run.bytes = await api.chunk(data.slice(i, i + 8 * 1024 * 1024))
      if (run.bytes > 500 * 1024 * 1024) void stop()
    })
    .catch((error) => {
      run.writeError = error
      errorLabel.textContent = error.message
      void stop()
    })
}

/**
 * Finalize once after queued writes and release all streams even when encoding failed.
 * @param {object} run Attempt whose recording is finishing.
 * @returns {Promise<void>} Finalization completion.
 */
async function finish(run) {
  if (run.finishing) return run.finishing
  run.stopping = true
  clearInterval(run.timer)
  if (active === run) {
    setPhase('finalizing')
    stopButton.disabled = pauseButton.disabled = true
  }
  run.finishing = (async () => {
    await run.writeChain
    try {
      const result = await api.finish()
      if (active !== run) return
      setPhase('done')
      stateLabel.textContent = run.writeError ? '录制已停止，请检查文件' : '录制完成'
      saveButton.disabled = false
      document.querySelector('#duration-text').textContent =
        document.querySelector('#record-time').textContent
      document.querySelector('#size-text').textContent =
        (result.bytes / 1024 / 1024).toFixed(2) + ' MB'
      if (isGif) {
        const image = document.querySelector('#gif-preview')
        image.src = result.url
        image.hidden = false
      } else {
        const playback = document.querySelector('#preview-video')
        playback.src = result.url
        playback.hidden = false
      }
      canvas.hidden = true
    } catch (error) {
      if (active !== run) return
      try {
        // The host resets a zero-byte finalization; nonempty drafts can never be discarded here.
        await api.abort()
        resetReady(run, run.cancelled ? '' : error.message)
      } catch {
        setPhase('error')
        errorLabel.textContent = error.message + '；已产生的内容保留在录屏草稿中。'
        stateLabel.textContent = '录制未完成'
      }
    } finally {
      release(run)
    }
  })()
  return run.finishing
}

/**
 * Cancel acquisition/countdown for retry, or finish an encoding attempt without losing its file.
 * @returns {Promise<void>} Cancellation or stop dispatch completion.
 */
async function stop() {
  const run = active
  if (!run || run.stopping || !['preparing', 'countdown', 'recording', 'paused'].includes(phase))
    return
  run.stopping = true
  clearInterval(run.timer)
  stopButton.disabled = pauseButton.disabled = true
  if (!run.encoding) {
    run.cancelled = true
    stateLabel.textContent = '正在取消…'
    release(run)
    try {
      await api.abort()
      resetReady(run)
    } catch (error) {
      setPhase('error')
      errorLabel.textContent = error.message
      stateLabel.textContent = '取消未完成'
    }
    return
  }
  setPhase('finalizing')
  stateLabel.textContent = '正在生成文件…'
  // A stop between encoding commitment and encoder.start still has no frames to preserve.
  if (!run.startedEncoding) run.cancelled = true
  if (run.recorder && run.recorder.state !== 'inactive') run.recorder.stop()
  else if (run.worker && run.startedEncoding) run.worker.postMessage({ type: 'finish' })
  else await finish(run)
}

/**
 * Crop the selected display using actual source pixels and send bounded frames to the encoder.
 * @param {object} run Attempt that owns the video and recording clock.
 * @returns {void} No value.
 */
function drawFrame(run) {
  if (active !== run || !run.video || run.video.readyState < 2) return
  const region = pixels(
    info.crop,
    run.video.videoWidth,
    run.video.videoHeight,
    info.width,
    info.height
  )
  ctx.drawImage(
    run.video,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height
  )
  if (phase !== 'recording') return
  run.elapsed = performance.now() - run.started
  document.querySelector('#record-time').textContent =
    String(Math.floor(run.elapsed / 60000)).padStart(2, '0') +
    ':' +
    String(Math.floor(run.elapsed / 1000) % 60).padStart(2, '0')
  if (isGif && !run.pendingFrame) {
    run.pendingFrame = true
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    run.worker.postMessage(
      {
        type: 'frame',
        rgba: rgba.buffer,
        width: canvas.width,
        height: canvas.height,
        time: Math.max(100, Math.round(run.elapsed))
      },
      [rgba.buffer]
    )
  }
  if (run.elapsed >= (isGif ? 30000 : 1800000)) void stop()
}

/**
 * Acquire explicit sources and encode after a cancellable countdown using isolated attempt state.
 * @returns {Promise<void>} Initialization or cancellation completion.
 */
async function start() {
  if (phase !== 'ready') return
  const run = {
    writeChain: Promise.resolve(),
    bytes: 0,
    elapsed: 0,
    pendingFrame: false,
    stopping: false,
    cancelled: false,
    encoding: false,
    startedEncoding: false
  }
  active = run
  setPhase('preparing')
  startButton.disabled = saveButton.disabled = true
  stopButton.disabled = false
  stopButton.textContent = '取消'
  systemAudioInput.disabled = microphoneInput.disabled = true
  stateLabel.textContent = '正在准备录制…'
  errorLabel.textContent = ''
  try {
    await saveOptions()
    assertActive(run)
    const profile = {
      low: { fps: 15, width: 1280, height: 720, bits: 2500000 },
      medium: { fps: 30, width: 1920, height: 1080, bits: 5000000 },
      high: { fps: 60, width: 1920, height: 1080, bits: 8000000 }
    }[document.querySelector('#quality-select').value]
    run.profile = profile
    const audio = info.microphone || info.systemAudio
    const formats = audio
      ? ['video/mp4;codecs=avc1.42001E,mp4a.40.2', 'video/webm;codecs=vp8,opus']
      : ['video/mp4;codecs=avc1.42001E', 'video/webm;codecs=vp8']
    const mime = isGif ? 'image/gif' : formats.find((type) => MediaRecorder.isTypeSupported(type))
    if (!mime) throw Error('当前设备没有可用的录屏编码器')
    await api.begin(mime.split(';')[0])
    assertActive(run)
    // Every asynchronously returned stream remains attached to its original attempt for cleanup.
    run.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: isGif ? 10 : profile.fps, max: isGif ? 10 : profile.fps } },
      audio: info.systemAudio
    })
    assertActive(run)
    if (info.microphone) {
      run.microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
        video: false
      })
      assertActive(run)
    }
    run.video = document.createElement('video')
    run.video.muted = true
    run.video.srcObject = run.stream
    await run.video.play()
    assertActive(run)
    const region = pixels(
        info.crop,
        run.video.videoWidth,
        run.video.videoHeight,
        info.width,
        info.height
      ),
      scale = Math.min(
        1,
        (isGif ? 720 : profile.width) / region.width,
        (isGif ? 720 : profile.height) / region.height
      )
    canvas.width = Math.max(2, Math.floor((region.width * scale) / 2) * 2)
    canvas.height = Math.max(2, Math.floor((region.height * scale) / 2) * 2)
    drawFrame(run)
    run.stream.getVideoTracks()[0].onended = () => {
      if (active === run) void stop()
    }
    setPhase('countdown')
    for (let count = 3; count > 0; count--) {
      stateLabel.textContent = String(count) + ' 秒后开始'
      document.querySelector('.countdown-number').textContent = String(count)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      assertActive(run)
    }
    if (isGif) {
      run.worker = new Worker(new URL('./gif-worker.mjs', import.meta.url), { type: 'module' })
      run.worker.onmessage = ({ data }) => {
        if (active !== run) return
        if (data.type === 'frame') run.pendingFrame = false
        else if (data.type === 'done') {
          queue(run, data.bytes)
          void finish(run)
        } else if (data.type === 'error') {
          run.writeError = Error(data.message)
          errorLabel.textContent = data.message
          void finish(run)
        }
      }
      run.worker.onerror = (event) => {
        run.writeError = Error(event.message)
        errorLabel.textContent = event.message
        void finish(run)
      }
    } else {
      run.output = canvas.captureStream(profile.fps)
      const sources = [run.stream, run.microphone].filter((media) => media?.getAudioTracks().length)
      if (sources.length) {
        run.mixer = new AudioContext()
        const destination = run.mixer.createMediaStreamDestination()
        for (const media of sources) run.mixer.createMediaStreamSource(media).connect(destination)
        for (const track of destination.stream.getAudioTracks()) run.output.addTrack(track)
      }
      run.recorder = new MediaRecorder(run.output, {
        mimeType: mime,
        videoBitsPerSecond: profile.bits
      })
      run.recorder.ondataavailable = (event) => {
        if (event.data.size) queue(run, event.data)
      }
      run.recorder.onstop = () => void finish(run)
      run.recorder.onerror = (event) => {
        run.writeError = Error(event.error?.message || '编码失败')
        errorLabel.textContent = run.writeError.message
        void stop()
      }
    }
    // Commit encoding before starting it; after this point only finalization may reset an empty file.
    run.encoding = true
    await api.started()
    assertActive(run)
    if (isGif) run.worker.postMessage({ type: 'start' })
    else run.recorder.start(500)
    run.startedEncoding = true
    run.started = performance.now()
    setPhase('recording')
    stateLabel.textContent = '● 正在录制'
    stopButton.textContent = '停止'
    pauseButton.disabled = false
    run.timer = setInterval(() => drawFrame(run), isGif ? 100 : Math.round(1000 / profile.fps))
    drawFrame(run)
  } catch (error) {
    release(run)
    if (active !== run || run.cancelled || run.stopping) return
    errorLabel.textContent = '录屏失败：' + error.message
    if (run.encoding) {
      run.writeError = error
      run.stopping = true
      await finish(run)
    } else {
      try {
        await api.abort()
        resetReady(run, '录屏失败：' + error.message + '，可以重试。')
      } catch (abortError) {
        setPhase('error')
        stateLabel.textContent = '录制未开始'
        errorLabel.textContent += '；' + abortError.message
      }
    }
  }
}
startButton.onclick = start
stopButton.onclick = stop
pauseButton.onclick = () => {
  const run = active
  if (!run) return
  if (phase === 'recording') {
    setPhase('paused')
    run.pausedAt = performance.now()
    run.recorder?.pause()
    pauseButton.textContent = '继续'
    stateLabel.textContent = '已暂停'
  } else if (phase === 'paused') {
    run.started += performance.now() - run.pausedAt
    setPhase('recording')
    run.recorder?.resume()
    pauseButton.textContent = '暂停'
    stateLabel.textContent = '● 正在录制'
  }
}
for (const input of [systemAudioInput, microphoneInput])
  input.onchange = () => {
    if (phase === 'ready')
      void saveOptions().catch((error) => {
        errorLabel.textContent = error.message
      })
  }
saveButton.onclick = async () => {
  saveButton.disabled = true
  try {
    const filename = await api.save()
    if (filename) {
      stateLabel.textContent = '已保存'
      await api.close()
    }
  } catch (error) {
    errorLabel.textContent = error.message
  } finally {
    saveButton.disabled = false
  }
}
document.querySelector('#resume-btn').onclick = () => pauseButton.click()
document.querySelector('#close-control').onclick = stop
document.querySelector('#cancel-record').onclick = () => api.close()
document.querySelector('#discard-btn').onclick = () => api.close()
// Keep advanced controls honest until their owned host integrations are implemented.
for (const id of ['enable-camera', 'enable-mouse-highlight', 'enable-key-display']) {
  const input = document.querySelector('#' + id)
  input.checked = false
  input.disabled = true
  input.closest('label').title = '此功能暂未支持'
}
document.querySelector('#edit-video-btn').disabled = true
document.querySelector('#edit-video-btn').title = '视频编辑暂未支持'
document.querySelector('#preview-video').hidden = isGif
document.querySelector('#discard-btn').textContent = '关闭'
setPhase('ready')
api.onStop(stop)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close()
  else if (event.code === 'Space' && ['recording', 'paused'].includes(phase)) {
    event.preventDefault()
    pauseButton.click()
  }
})
window.addEventListener('unload', () => release(active))
updateDetails()
// Publish readiness only after options and all retry/cancellation handlers are installed.
document.body.dataset.ready = 'true'
