const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {packageFiles,sourceOf}=require('../scripts/package.cjs');
const root=path.resolve(__dirname,'..');
// The release zip is the extension people install: every relative require and every manifest entry must be inside it.
test('the release file list holds every module the shipped code requires and every manifest entry',()=>{
 const files=packageFiles(),set=new Set(files);
 assert.ok(set.has('dist/i18n/index.js')&&set.has('dist/i18n/registry.js')&&set.has('dist/i18n/en/git.js'),'nested dist directories are shipped');
 assert.ok(files.every(file=>!/(^|\/)tests\//.test(file)&&!/\.d\.c?ts$/.test(file)),'no tests or type declarations');
 const manifest=require('../package.json');
 for(const entry of [manifest.main,...Object.values(manifest.panels).map(panel=>panel.main),manifest.contributions.scene.script,manifest.contributions.toolbar.middle])assert.ok(set.has(path.posix.normalize(entry)),entry);
 for(const name of ['core','inspector','bridge','i18n'])assert.ok(set.has('static/mcp-tools.'+name+'.json'),name);
 assert.ok(set.has('i18n/en.js')&&set.has('i18n/zh.js')&&set.has('templates/mcp.json')&&set.has('LICENSE'));
 const missing=[];
 for(const file of files.filter(name=>/\.(c?js)$/.test(name))){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  for(const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)){
   const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]));
   const found=[target,target+'.js',target+'.cjs',target+'.json',target+'/index.js'].some(candidate=>set.has(candidate));
   if(!found)missing.push(file+' -> '+match[1]);
  }
 }
 assert.deepEqual(missing,[],'every relative require resolves inside the package');
});
test('the shipped .gitignore keeps the per-machine cache with the MCP token out of every project',()=>{
 assert.ok(packageFiles().includes('.gitignore'));assert.equal(sourceOf('.gitignore'),'scripts/release.gitignore');
 const lines=fs.readFileSync(path.join(root,sourceOf('.gitignore')),'utf8').split('\n').map(line=>line.trim());
 assert.ok(lines.includes('.cache/'));assert.ok(!lines.includes('dist/'),'the shipped build itself is not ignored');
});
