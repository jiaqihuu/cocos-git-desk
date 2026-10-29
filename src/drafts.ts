import { createHash, randomUUID } from 'crypto';
import { constants, promises as fs, Stats } from 'fs';
import path from 'path';
import { CommitDraft } from './types';
import { MessageError } from './i18n';

const FILE_LIMIT = 64 * 1024;
const VERSION = /^[a-f0-9]{64}$/;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;

function checkMessage(message: unknown): asserts message is string {
    if (typeof message !== 'string' || message.length > 5000 || message.includes('\0')) throw new MessageError('git.drafts.textInvalid');
}

export class DraftStore {
    private directory: string;

    constructor(cache: string) {
        if (!path.isAbsolute(cache) || cache.includes('\0')) throw new MessageError('git.drafts.cacheNotAbsolute');
        this.directory = path.join(cache, 'drafts');
    }

    private async identity(repoPath: string): Promise<string> {
        if (!path.isAbsolute(repoPath) || repoPath.includes('\0')) throw new MessageError('git.drafts.repoNotAbsolute');
        const canonical = await fs.realpath(repoPath);
        if (!(await fs.stat(canonical)).isDirectory()) throw new MessageError('git.drafts.repoNotDirectory');
        return canonical;
    }

    private async directories(create: boolean): Promise<Stats | undefined> {
        const root = path.parse(this.directory).root;
        let current = root, latest: Stats | undefined;
        for (const component of this.directory.slice(root.length).split(path.sep).filter(Boolean)) {
            current = path.join(current, component);
            let stat = await fs.lstat(current).catch(error => { if (absent(error)) return undefined; throw error; });
            if (!stat && create) {
                await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
                stat = await fs.lstat(current);
            }
            if (!stat) return undefined;
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MessageError('git.drafts.cacheHasLink');
            latest = stat;
        }
        return latest;
    }

    private async unchangedDirectory(expected: Stats): Promise<void> {
        const current = await this.directories(false);
        if (!current || !sameFile(current, expected)) throw new MessageError('git.drafts.cacheChanged');
    }

    private async load(repo: string, filename: string): Promise<CommitDraft> {
        const entry = await fs.lstat(filename).catch(error => { if (absent(error)) return undefined; throw error; });
        if (!entry) return { message: '', version: digest('git-desk-draft-v1\0' + repo + '\0missing') };
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > FILE_LIMIT) throw new MessageError('git.drafts.fileTypeInvalid');
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1 || !sameFile(entry, opened) || opened.size > FILE_LIMIT) throw new MessageError('git.drafts.fileChanged');
            const buffer = Buffer.alloc(FILE_LIMIT + 1);
            let size = 0;
            while (size < buffer.length) {
                const result = await handle.read(buffer, size, buffer.length - size, size);
                if (!result.bytesRead) break;
                size += result.bytesRead;
            }
            const after = await handle.stat(), bytes = buffer.subarray(0, size), text = bytes.toString('utf8');
            if (size > FILE_LIMIT || opened.size !== size || after.size !== size || opened.mtimeMs !== after.mtimeMs || !Buffer.from(text, 'utf8').equals(bytes)) throw new MessageError('git.drafts.fileReadInvalid');
            let record: unknown;
            try { record = JSON.parse(text); } catch { throw new MessageError('git.drafts.fileCorrupt'); }
            if (!record || typeof record !== 'object' || Array.isArray(record) || !('schema' in record) || record.schema !== 1 || !('repo' in record) || record.repo !== repo || !('message' in record) || !('revision' in record) || typeof record.revision !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.revision) || !('updatedAt' in record) || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || new Date(record.updatedAt).toISOString() !== record.updatedAt || Object.keys(record).sort().join(',') !== 'message,repo,revision,schema,updatedAt') throw new MessageError('git.drafts.fileIdentityInvalid');
            checkMessage(record.message);
            return { message: record.message, version: digest(bytes), updatedAt: record.updatedAt };
        } finally { await handle.close(); }
    }

    async read(repoPath: string): Promise<CommitDraft> {
        const repo = await this.identity(repoPath), directory = await this.directories(false);
        if (!directory) return { message: '', version: digest('git-desk-draft-v1\0' + repo + '\0missing') };
        const draft = await this.load(repo, path.join(this.directory, digest(repo) + '.json'));
        await this.unchangedDirectory(directory);
        return draft;
    }

    private async removeOwned(filename: string, owner: Stats, directory: Stats): Promise<void> {
        await this.unchangedDirectory(directory);
        const current = await fs.lstat(filename).catch(error => { if (absent(error)) return undefined; throw error; });
        if (current && current.isFile() && sameFile(current, owner)) await fs.unlink(filename);
    }

    async save(repoPath: string, message: string, version: string): Promise<CommitDraft> {
        checkMessage(message);
        if (typeof version !== 'string' || !VERSION.test(version)) throw new MessageError('git.drafts.versionInvalid');
        const repo = await this.identity(repoPath), directory = await this.directories(true);
        if (!directory) throw new MessageError('git.drafts.cannotCreateCache');
        const filename = path.join(this.directory, digest(repo) + '.json'), lockname = filename + '.lock';
        const lock = await fs.open(lockname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(error => {
            if (error.code === 'EEXIST') throw new MessageError('git.drafts.locked');
            throw error;
        });
        let owner: Stats | undefined, temporary: string | undefined, temporaryOwner: Stats | undefined;
        try {
            owner = await lock.stat();
            await this.unchangedDirectory(directory);
            const current = await this.load(repo, filename);
            if (current.version !== version) throw new MessageError('git.drafts.modifiedElsewhere');
            if (current.message === message) return current;
            const record = { schema: 1, repo, message, revision: randomUUID(), updatedAt: new Date().toISOString() };
            const bytes = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
            if (bytes.length > FILE_LIMIT) throw new MessageError('git.drafts.fileTooLarge');
            temporary = path.join(this.directory, '.' + digest(repo) + '.' + randomUUID() + '.tmp');
            const output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                temporaryOwner = await output.stat();
                await output.writeFile(bytes);
                await output.sync();
            } finally { await output.close(); }
            await this.unchangedDirectory(directory);
            const activeLock = await fs.lstat(lockname);
            if (!activeLock.isFile() || !sameFile(activeLock, owner)) throw new MessageError('git.drafts.lockChanged');
            if ((await this.load(repo, filename)).version !== version) throw new MessageError('git.drafts.changedWhileSaving');
            const pending = await fs.lstat(temporary);
            if (!pending.isFile() || pending.nlink !== 1 || !sameFile(pending, temporaryOwner)) throw new MessageError('git.drafts.tempChanged');
            await fs.rename(temporary, filename);
            temporary = undefined;
            return { message, version: digest(bytes), updatedAt: record.updatedAt };
        } finally {
            // Cleanup cannot undo an atomic save. Keep inaccessible leftovers for explicit recovery, never delete another writer's files.
            await lock.close();
            if (temporary && temporaryOwner) await this.removeOwned(temporary, temporaryOwner, directory).catch(() => undefined);
            if (owner) await this.removeOwned(lockname, owner, directory).catch(() => undefined);
        }
    }
}
