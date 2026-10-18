const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const { pathToFileURL } = require('node:url')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stools-video-verify-'))
app.setPath('userData', root)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
/**
 * Decode the exported video and sample distinct timeline frames using Chromium.
 * @returns {Promise<void>} Reports dimensions, duration and changing decoded frames.
 * @throws When decoding fails or output contains no motion.
 */
async function verify() {
  const file = process.argv[2]
  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, sandbox: true }
  })
  await win.loadFile(path.join(__dirname, 'video-verifier.html'))
  const result = await win.webContents.executeJavaScript(`(async()=>{
  const video=document.createElement('video');video.muted=true;document.body.append(video)
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('decode failed'));video.src=${JSON.stringify(pathToFileURL(file).href)}})
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90
  const context=canvas.getContext('2d'), hashes=[]
  for(const time of [0.1,0.3,0.5,0.7,0.9,1.1]){
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('seek timeout')),5000);video.onseeked=()=>{clearTimeout(timer);resolve()};video.currentTime=time})
   context.drawImage(video,0,0,160,90);const data=context.getImageData(0,0,160,90).data
   let hash=2166136261;for(const b of data) hash=Math.imul(hash^b,16777619);hashes.push(hash>>>0)
  }
  return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,uniqueFrames:new Set(hashes).size,hashes}
 })()`)
  console.log(JSON.stringify(result))
  if (result.uniqueFrames < 2 || result.duration < 1.5 || result.width < 100)
    throw Error('Video content validation failed')
  win.destroy()
  app.quit()
}
app
  .whenReady()
  .then(verify)
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
