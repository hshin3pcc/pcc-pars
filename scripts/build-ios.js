'use strict';

/*
 * Compose the iOS app's web assets into ios/PARSApp/www/ (a folder reference in the Xcode project, copied
 * into the app bundle as-is):
 *   index.html, app.js, core.js, style.css  — the PWA, unchanged (it detects the app shell at runtime)
 *   pars-bridge.js                          — src/core.js + src/ios-bridge.js, injected into the PARS web view
 *
 *   npm run build-ios
 *
 * Exported as build() so the test suite can assert the COMMITTED www/ is current — the same twin-file
 * discipline as pwa/core.js and pwa/fill.js (the shipped artifact must be built from the tested source).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ios', 'PARSApp', 'www');

function build() {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const core = read('src/core.js');
  const bridge = read('src/ios-bridge.js');
  const parsBridge = '(function(){\n' + core + '\n' + bridge + '\n})();\n';
  new Function(parsBridge);   // parse gate — never ship a bridge that won't run
  return {
    files: {
      'index.html': read('pwa/index.html'),
      'app.js': read('pwa/app.js'),
      'core.js': core,
      'style.css': read('pwa/style.css'),
      'pars-bridge.js': parsBridge,
    },
  };
}

function write() {
  fs.mkdirSync(OUT, { recursive: true });
  const { files } = build();
  Object.keys(files).forEach((name) => fs.writeFileSync(path.join(OUT, name), files[name]));
  console.log(`ios www: wrote ${Object.keys(files).join(', ')} → ${path.relative(ROOT, OUT)}/`);
}

module.exports = { build, OUT };
if (require.main === module) write();
