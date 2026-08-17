'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

let _put;

async function getPut() {
  if (_put) return _put;
  const { put } = await import('@vercel/blob');
  _put = put;
  return _put;
}

function randomName(originalName) {
  const ext = path.extname(originalName || '').slice(0, 16).replace(/[^.a-zA-Z0-9]/g, '');
  return crypto.randomBytes(16).toString('hex') + (ext || '');
}

async function uploadFile(buffer, originalName, mime) {
  const name = randomName(originalName);
  const put = await getPut();
  const blob = await put(name, buffer, { access: 'public', type: mime });
  return blob.url;
}

module.exports = { uploadFile };
