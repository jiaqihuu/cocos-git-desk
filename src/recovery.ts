import { createHash } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import { MessageError } from './i18n';

export const RECOVERY_FILE_BYTES = 10 * 1024 * 1024;
export const RECOVERY_TOTAL_BYTES = 50 * 1024 * 1024;
export const RECOVERY_PATHS = 50;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const missing = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT';
export interface DiskStamp { exists: boolean; hash: string; mode: number; size: number; }

export class RecoveryStore {

    private relative(name: string): void {
        if (typeof name !== 'string' || !name || Buffer.byteLength(name,'utf8') > 4096 || name.includes('\\') || name.includes('\0') || path.posix.normalize(name) !== name || name.split('/').some(p => p.toLowerCase() === '.git' || !p || p === '..' || (process.platform === 'win32' && (/[<>:"|?*]/.test(p) || /[. ]$/.test(p)))) || path.isAbsolute(name)) throw new MessageError('git.recovery.pathNotNormalized');
    }

    async filename(repo: string, name: string, missingParents = false): Promise<string> {
        this.relative(name);
        const filename = path.join(repo, name), parent = path.dirname(filename);
        const real=await fs.realpath(parent).catch(e=>{if(missingParents && missing(e))return undefined;throw e;});
        if(real!==undefined && real!==parent)throw new MessageError('git.recovery.pathThroughSymlink');
        let current = repo;
        for (const part of name.split('/').slice(0, -1)) {
            current = path.join(current, part);
            const directory=await fs.lstat(current).catch(e=>{if(missingParents && missing(e))return undefined;throw e;});
            if(!directory)break;
            if(!directory.isDirectory() || directory.isSymbolicLink())throw new MessageError('git.recovery.pathThroughLink');
            const nested = await fs.lstat(path.join(current, '.git')).catch(e => { if (missing(e)) return undefined; throw e; });
            if (nested) throw new MessageError('git.recovery.nestedRepository');
        }
        return filename;
    }

    async readDisk(repo: string, name: string, limit = RECOVERY_FILE_BYTES): Promise<{ stamp: DiskStamp; bytes?: Buffer }> {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECOVERY_FILE_BYTES) throw new MessageError('git.recovery.invalidReadLimit');
        const filename = await this.filename(repo, name, true);
        const stat = await fs.lstat(filename).catch(e => { if (missing(e)) return undefined; throw e; });
        if (!stat) return { stamp: { exists: false, hash: hash('absent'), mode: 0, size: 0 } };
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new MessageError('git.recovery.plainFileOnly', { mib: limit / 1024 / 1024, name });
        const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const opened = await file.stat();
            if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile() || opened.nlink !== 1) throw new MessageError('git.recovery.changedWhileOpening', { name });
            const chunks: Buffer[] = []; let length = 0;
            while (true) {
                const block = Buffer.alloc(65536), result = await file.read(block, 0, block.length, length);
                if (!result.bytesRead) break;
                length += result.bytesRead;
                if (length > limit) throw new MessageError('git.recovery.readTooLarge', { mib: limit / 1024 / 1024, name });
                chunks.push(block.subarray(0, result.bytesRead));
            }
            const end = await file.stat(), bytes = Buffer.concat(chunks);
            if (length !== opened.size || end.size !== opened.size || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs) throw new MessageError('git.recovery.changedWhileReading', { name });
            return { stamp: { exists: true, hash: hash(bytes), mode: end.mode & 0o777, size: length }, bytes };
        } finally { await file.close(); }
    }

    async stamps(repo: string, names: string[]): Promise<DiskStamp[]> {
        if (!names.length || names.length > RECOVERY_PATHS || new Set(names).size !== names.length) throw new MessageError('git.recovery.pathCount');
        if(names.reduce((n,name)=>n+Buffer.byteLength(name,'utf8'),0)>96*1024)throw new MessageError('git.recovery.pathListTooLarge');
        const stamps: DiskStamp[] = []; let bytes = 0;
        for (const name of names) {
            const { stamp } = await this.readDisk(repo, name); bytes += stamp.size;
            if (bytes > RECOVERY_TOTAL_BYTES) throw new MessageError('git.recovery.diskTooLarge');
            stamps.push(stamp);
        }
        return stamps;
    }
}
