// Platform differences the tests have to know about.
// Windows forbids * ? : " < > | and control characters in file names. Tests whose subject is such names skip there;
// tests that only happen to use one keep the same shape with legal characters (brackets stay: they are glob syntax too).
const windows = process.platform === 'win32';
const replacements = { '*': '[star]', '?': '[q]', ':': '[colon]', '"': "'", '<': '(', '>': ')', '|': '!' };
function portableName(name) {
    if (!windows) return name;
    return name.replace(/[*?:"<>|]/g, c => replacements[c]).replace(/\r?\n/g, ' nl ').replace(/\t/g, ' tab ');
}
const exoticNames = windows && 'file names with * ? : " or control characters cannot exist on Windows';
// POSIX permission bits are not kept on Windows; private files rely on the user profile ACL there.
const posixModes = !windows;
// A symbolic link target such as /outside is stored with the current drive on Windows (D:/outside).
const linkTarget = text => windows ? text.replace(/^[A-Za-z]:/, '') : text;
module.exports = { windows, portableName, exoticNames, posixModes, linkTarget };
