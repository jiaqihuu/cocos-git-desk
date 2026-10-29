// Preloaded by `npm test` before the language preload. Git for Windows enables core.autocrlf, which turns the
// fixtures' LF files into CRLF on checkout; the tests assert exact bytes, so they run with autocrlf off.
// Command-line configuration through the environment leaves the user's own Git settings untouched.
const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
process.env.GIT_CONFIG_COUNT = String(count + 1);
process.env['GIT_CONFIG_KEY_' + count] = 'core.autocrlf';
process.env['GIT_CONFIG_VALUE_' + count] = 'false';
// Fixtures create their temporary directories under these two folders; a fresh checkout has neither.
const fs = require('node:fs'), path = require('node:path');
for (const name of ['.cache', '.test-work']) fs.mkdirSync(path.resolve(__dirname, '..', name), { recursive: true });
