const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
if (process.platform !== 'win32') process.exit(0)
const root = path.resolve(__dirname, '..')
const compiler = path.join(
  process.env.WINDIR || 'C:/Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
)
if (!fs.existsSync(compiler))
  throw new Error('Building Windows search requires the .NET Framework 4 compiler')
execFileSync(
  compiler,
  [
    '/nologo',
    '/optimize+',
    '/platform:x64',
    '/r:System.Web.Extensions.dll',
    '/r:System.ServiceProcess.dll',
    '/main:SearchService',
    '/out:' + path.join(root, 'resources/search/stools-ntfs.exe'),
    path.join(root, 'src/native/search/NtfsReader.cs'),
    path.join(root, 'src/native/search/SearchService.cs')
  ],
  { stdio: 'inherit', windowsHide: true }
)

// Build the ordinary-user SDK IPC bridge; it never installs a service.
execFileSync(
  compiler,
  [
    '/nologo',
    '/optimize+',
    '/platform:x64',
    '/r:System.Web.Extensions.dll',
    '/r:System.Windows.Forms.dll',
    '/out:' + path.join(root, 'resources/search/stools-everything.exe'),
    path.join(root, 'src/native/search/EverythingSdk.cs')
  ],
  { stdio: 'inherit', windowsHide: true }
)
