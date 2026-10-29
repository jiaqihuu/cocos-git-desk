const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const documents = ['.gitignore', 'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'SECURITY.md', 'docs/AGENT_API.md', 'docs/RUNTIME_INSPECTOR.md', 'docs/CONFIG.md', 'docs/TOOLS.md', 'scripts/git-desk-mcp.py', 'scripts/project-update.py', 'scripts/update_all_current_branches.py'];
// Every runtime file, recursively: dist has subdirectories (dist/i18n/...). Tests and type declarations stay out, and a
// compiled file whose TypeScript source is gone (tsc never deletes outputs) is not shipped.
function packageFiles(base = root) {
    const files = [...documents];
    const walk = (directory, keep) => {
        if (!fs.existsSync(path.join(base, directory))) return;
        for (const item of fs.readdirSync(path.join(base, directory), { withFileTypes: true })) {
            const relative = directory + '/' + item.name;
            if (item.isDirectory()) { if (item.name !== 'tests') walk(relative, keep); }
            else if (item.isFile() && !/\.d\.c?ts$/.test(item.name) && item.name !== '.DS_Store' && keep(relative)) files.push(relative);
        }
    };
    walk('dist', relative => !relative.endsWith('.js') || fs.existsSync(path.join(base, 'src', relative.slice(5, -3) + '.ts')));
    for (const directory of ['static', 'i18n', 'templates', 'browser-debug']) walk(directory, () => true);
    return files.sort();
}
// Archive names whose content comes from another file: the shipped .gitignore is not the repository's own.
const sources = { '.gitignore': 'scripts/release.gitignore' };
const sourceOf = name => sources[name] || name;
module.exports = { packageFiles, sourceOf };
if (require.main !== module) return;
const files = packageFiles();
if (!files.includes('dist/main.js') || !files.includes('dist/panel.js') || !files.includes('dist/i18n/index.js')) throw new Error('Run npm run build before packaging.');
function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const file of files) {
    const name = Buffer.from(file), data = fs.readFileSync(path.join(root, sourceOf(file))), compressed = zlib.deflateRawSync(data), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(entry, name); offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, directory, end]);
const release = path.join(root, 'releases'); fs.mkdirSync(release, { recursive: true });
const name = `${manifest.name}-${manifest.version}.zip`; const output = path.join(release, name);
fs.writeFileSync(output, zip); fs.writeFileSync(output + '.sha256', crypto.createHash('sha256').update(zip).digest('hex') + '  ' + name + '\n');
console.log(output);
