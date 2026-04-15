// js/im-core/utils.js

export function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function getNestedValue(obj, path) {
    if (!path || !obj) return '';
    return path.split('.').reduce((cur, key) => cur?.[key], obj) ?? '';
}

export function setNestedValue(obj, path, value) {
    if (!path || !obj) return;
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) {
            cur[keys[i]] = {};
        }
        cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
}
