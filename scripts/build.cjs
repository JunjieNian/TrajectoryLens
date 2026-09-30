'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = path.resolve(__dirname, '../web');
const output = path.resolve(__dirname, '../artifacts/TrajectoryLens.html');
let html = fs.readFileSync(path.join(source,'index.html'),'utf8');
html = html.replace(/<link\b[^>]*>/g, tag => {
  const href = tag.match(/\bhref="([^"]+)"/);
  if (!href || /^(https?:|data:)/.test(href[1])) return tag;
  if (/\brel="stylesheet"/.test(tag)) return '<style>' + fs.readFileSync(path.join(source,href[1].split('?')[0]),'utf8') + '</style>';
  if (/\brel="icon"/.test(tag) && /\.svg$/.test(href[1])) return tag.replace(href[1], 'data:image/svg+xml,' + encodeURIComponent(fs.readFileSync(path.join(source,href[1]),'utf8')));
  return tag;
});
let scriptCount=0;
html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g, (_,file) => {
  const script=fs.readFileSync(path.join(source,file.split('?')[0]),'utf8');
  new vm.Script(script,{filename:file});
  scriptCount++;
  return '<script>' + script.replace(/<\/script/gi,'<\\/script') + '</script>';
});
if (/<script\b[^>]*\bsrc=/.test(html)) throw new Error('External application script remains');
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,html,'utf8');
console.log(JSON.stringify({output,bytes:Buffer.byteLength(html),scriptCount}));
