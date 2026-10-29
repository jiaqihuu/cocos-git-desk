import { t } from './i18n';
import type { Params } from './i18n';

// Static panel markup keeps its Chinese text inline and names a message id per text:
// data-i18n replaces the element's own text (the first non-blank direct text node, so a <label> keeps its <input>),
// data-i18n-title / data-i18n-aria / data-i18n-placeholder replace those attributes. Run once when a panel mounts.
const ATTRIBUTES: readonly [string, string][] = [['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label'], ['data-i18n-placeholder', 'placeholder']];

export function localizeElement(root: ParentNode & { querySelectorAll: Element['querySelectorAll'] }): void {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
        const text = t(element.dataset.i18n || '');
        const node = Array.from(element.childNodes).find(child => child.nodeType === 3 && !!child.textContent?.trim());
        if (node) node.textContent = text;
        else if (!element.children.length) element.textContent = text;
    }
    for (const [data, attribute] of ATTRIBUTES) {
        for (const element of Array.from(root.querySelectorAll<HTMLElement>('[' + data + ']'))) element.setAttribute(attribute, t(element.getAttribute(data) || ''));
    }
}

/** A message escaped for an HTML attribute value inside a template string. */
export function attr(id: string, params?: Params): string { return t(id, params).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
/** A message escaped for HTML text content inside a template string. */
export function html(id: string, params?: Params): string { return t(id, params).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
