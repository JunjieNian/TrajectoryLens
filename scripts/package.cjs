'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'artifacts','TrajectoryLens-source.zip');
const names=['web','tests','examples','scripts','archive','README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','.gitignore','.gitattributes','artifacts/TrajectoryLens.html','artifacts/process-map.jpg','artifacts/timeline.jpg'];
const inputs=names.map(name=>path.resolve(root,name));
for(const item of inputs){
  const rel=path.relative(root,item);
  if(rel.startsWith('..')||path.isAbsolute(rel)||!fs.existsSync(item)||fs.lstatSync(item).isSymbolicLink())throw new Error('Unsafe or missing archive input: '+item);
}
fs.mkdirSync(path.dirname(output),{recursive:true});
// A staging tree keeps artifacts/ intact. Compressing individual nested files
// directly would flatten them and break the README and packaging script.
const work=path.join(root,'work');fs.mkdirSync(work,{recursive:true});
const stage=fs.mkdtempSync(path.join(work,'source-package-'));
for(const name of names){
  const target=path.join(stage,name);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.cpSync(path.join(root,name),target,{recursive:true,dereference:false});
}
const quote=text=>"'"+text.replace(/'/g,"''")+"'";
const staged=fs.readdirSync(stage).map(name=>path.join(stage,name));
const command='Compress-Archive -LiteralPath @('+staged.map(quote).join(',')+') -DestinationPath '+quote(output)+' -Force';
const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true});
if(result.error)throw result.error;
if(result.status!==0)throw new Error(result.stderr||result.stdout);
console.log(JSON.stringify({output,bytes:fs.statSync(output).size}));
