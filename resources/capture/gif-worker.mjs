import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.mjs'
let encoder,
  previousTime = 0,
  count = 0
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      encoder = GIFEncoder()
      previousTime = 0
      count = 0
      self.postMessage({ type: 'ready' })
    } else if (data.type === 'frame') {
      const rgba = new Uint8Array(data.rgba),
        palette = quantize(rgba, 256, { format: 'rgb565' }),
        indexed = applyPalette(rgba, palette, 'rgb565')
      encoder.writeFrame(indexed, data.width, data.height, {
        palette,
        delay: Math.max(20, data.time - previousTime),
        repeat: 0
      })
      previousTime = data.time
      count++
      self.postMessage({ type: 'frame', count })
    } else if (data.type === 'finish') {
      if (!count) throw Error('没有录到 GIF 画面')
      encoder.finish()
      const bytes = encoder.bytes()
      self.postMessage({ type: 'done', bytes }, [bytes.buffer])
      encoder = null
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message })
  }
}
