'use strict';

/**
 * Rasterise assets/logo.svg into:
 *   - assets/icon.png  (256px, used as the BrowserWindow icon)
 *   - assets/icon.ico  (16/32/48/64/128/256, used by the Windows shortcut)
 *
 * Uses Electron's own offscreen renderer rather than pulling in an image library:
 * the SVG is rendered by the exact engine that displays the app, and the tool adds
 * no dependency. Run with:  node_modules\electron\dist\electron.exe tools\make-icon.js
 */

delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 256;
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const ASSETS = path.join(__dirname, '..', 'assets');

/**
 * Pack PNGs into a single .ico.
 *
 * The format is a 6-byte header, then one 16-byte directory entry per image, then
 * the image payloads. Vista and later accept PNG payloads directly, so no BMP
 * conversion is needed. A dimension of 256 is written as 0 -- the field is one byte.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach((img, i) => {
    const e = 16 * i;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0);   // width
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);   // height
    dir.writeUInt8(0, e + 2);                                // palette entries
    dir.writeUInt8(0, e + 3);                                // reserved
    dir.writeUInt16LE(1, e + 4);                             // colour planes
    dir.writeUInt16LE(32, e + 6);                            // bits per pixel
    dir.writeUInt32LE(img.buf.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.buf.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.buf)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const svg = fs.readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8');
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;width:' + SIZE + 'px;height:' + SIZE + 'px;' +
    'background:transparent;overflow:hidden}' +
    'svg{width:' + SIZE + 'px;height:' + SIZE + 'px;display:block}</style>' +
    svg;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });

  let written = false;

  win.webContents.on('paint', (_event, _dirty, image) => {
    if (written || image.isEmpty()) return;
    const png = image.toPNG();
    // The first paint can be a blank frame; wait for one with real content.
    if (!png || png.length < 2000) return;
    written = true;
    fs.writeFileSync(path.join(ASSETS, 'icon.png'), png);
    console.log('icon.png ecrit : ' + png.length + ' octets, ' + SIZE + 'x' + SIZE);

    // Downscale the same render for each icon size, rather than re-rendering:
    // identical artwork at every resolution, and 'best' quality keeps 16px legible.
    const images = ICO_SIZES.map((size) => ({
      size,
      buf: size === SIZE
        ? png
        : image.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    }));
    const ico = buildIco(images);
    fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
    console.log('icon.ico ecrit : ' + ico.length + ' octets, tailles ' + ICO_SIZES.join('/'));

    setTimeout(() => app.quit(), 100);
  });

  win.webContents.setFrameRate(10);
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  setTimeout(() => {
    if (!written) console.error('echec : aucune frame exploitable.');
    app.quit();
  }, 15000);
});
