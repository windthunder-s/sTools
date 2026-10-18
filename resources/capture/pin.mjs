const info = await window.capture.describe()
document.querySelector('img').src = info.image
document.querySelector('#copy').onclick = () => window.capture.image('copy', info.image)
document.querySelector('#save').onclick = () => window.capture.image('save', info.image)
document.querySelector('#close').onclick = () => window.capture.close()
document.querySelector('#opacity').oninput = (event) =>
  window.capture.opacity(Number(event.target.value) / 100)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.capture.close()
  if (event.ctrlKey && event.key.toLowerCase() === 'c') window.capture.image('copy', info.image)
})

// Publish readiness only after source decoding and event handlers are installed.
document.body.dataset.ready = 'true'
