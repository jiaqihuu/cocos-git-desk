import fs from 'fs';
import path from 'path';
import type { Action, Plan } from './types';
import { t, MessageError } from './i18n';

const preferenceFile = path.resolve(__dirname, '../.cache/operation-warnings.json');
const legacyFile = path.resolve(__dirname, '../.cache/update-warnings.json');
const updateConfirmationsFile = path.resolve(__dirname, '../.cache/update-confirmations.json');
type Preferences = Partial<Record<Action, string[]>>;

function readPreferences(filename: string): Preferences {
    try {
        const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessageError('misc.warnings.invalidFormat');
        const result: Preferences = {};
        for (const [action, warnings] of Object.entries(value)) {
            if (!Array.isArray(warnings) || !warnings.every(text => typeof text === 'string')) throw new MessageError('misc.warnings.invalidContent');
            Object.defineProperty(result, action, { value: warnings, enumerable: true, writable: true, configurable: true });
        }
        return result;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(t('misc.warnings.cannotReadRead'), error);
        return {};
    }
}

export function groupPlanWarnings(plan: Pick<Plan, 'warnings' | 'generalWarnings'>, acknowledged: readonly string[]) {
    const general = new Set(plan.generalWarnings || []), seen = new Set(acknowledged);
    return {
        general: plan.warnings.filter(text => general.has(text)),
        known: plan.warnings.filter(text => general.has(text) && seen.has(text)),
        fresh: plan.warnings.filter(text => !general.has(text) || !seen.has(text)),
    };
}

export function canRepeatUpdate(action: Action, plan: Plan, confirmed: boolean, acknowledged: readonly string[], now = Date.now()): boolean {
    return action === 'updateAll' && !!plan.repeatConfirmationKey && confirmed && plan.expiresAt > now
        && !plan.paths.length && !plan.patch && !!plan.generalWarnings?.length
        && groupPlanWarnings(plan, acknowledged).fresh.length === 0;
}

export class WarningPreferences {
    constructor(private filename = preferenceFile, private legacy = legacyFile, private confirmations = updateConfirmationsFile) {}

    private updateKeys(): string[] {
        try {
            const value: unknown = JSON.parse(fs.readFileSync(this.confirmations, 'utf8'));
            if (Array.isArray(value) && value.every(key => typeof key === 'string')) return value;
            console.warn(t('misc.warnings.updateConfirmInvalid'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(t('misc.warnings.cannotReadUpdateConfirm'), error);
        }
        return [];
    }

    confirmedUpdate(key: string): boolean { return this.updateKeys().includes(key); }

    confirmUpdate(key: string): void {
        try {
            const keys = [...this.updateKeys().filter(item => item !== key), key].slice(-64);
            fs.mkdirSync(path.dirname(this.confirmations), { recursive: true });
            fs.writeFileSync(this.confirmations, JSON.stringify(keys), 'utf8');
        } catch (error) { console.warn(t('misc.warnings.cannotSaveUpdateConfirm'), error); }
    }

    read(action: Action): string[] {
        const preferences = readPreferences(this.filename);
        if (Object.prototype.hasOwnProperty.call(preferences, action)) return preferences[action] || [];
        if (action === 'updateAll') {
            try {
                const value: unknown = JSON.parse(fs.readFileSync(this.legacy, 'utf8'));
                if (Array.isArray(value) && value.every(text => typeof text === 'string')) return value;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(t('misc.warnings.cannotReadLegacy'), error);
            }
        }
        return [];
    }

    acknowledge(action: Action, warnings: string[]): void {
        if (!warnings.length) return;
        try {
            const preferences = readPreferences(this.filename);
            preferences[action] = [...new Set(warnings)];
            fs.mkdirSync(path.dirname(this.filename), { recursive: true });
            fs.writeFileSync(this.filename, JSON.stringify(preferences), 'utf8');
        } catch (error) { console.warn(t('misc.warnings.cannotSaveRead'), error); }
    }
}
