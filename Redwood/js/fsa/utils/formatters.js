// js/fsa/utils/formatters.js

// ── Indian integer formatter (e.g. 1234567 → "12,34,567") ────────────
function formatIndianInteger(intStr) {
    const s = intStr.replace(/^0+/, '') || '0';
    if (s.length <= 3) return s;
    const lastThree = s.slice(-3);
    const rest = s.slice(0, -3);
    return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
}

/**
 * Format a number using Indian numbering system (en-IN).
 * @param {number} value
 * @param {number} [fractionDigits=2]
 * @returns {string}
 */
export function formatIN(value, fractionDigits = 2) {
    return Number(value).toLocaleString('en-IN', {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    });
}

/**
 * Parse a potentially Indian-formatted string ("12,34,567.89") to a float.
 * @param {string} str
 * @returns {number}
 */
export function parseFormattedNumber(str) {
    if (str === null || str === undefined) return 0;
    const raw = String(str).replace(/,/g, '').trim();
    return raw === '' ? 0 : parseFloat(raw) || 0;
}

/**
 * Apply live Indian comma formatting to a text input while preserving the
 * cursor position.  Call this inside an `input` event listener.
 * @param {HTMLInputElement} input
 * @returns {number} The clean numeric value (for storage).
 */
export function applyLiveIndianFormat(input) {
    const cursorPos  = input.selectionStart;
    const prevValue  = input.value;

    // Count commas before cursor in old value
    const commasBefore = (prevValue.slice(0, cursorPos).match(/,/g) || []).length;

    // Strip everything except digits and ONE decimal point
    let rawChars = prevValue.replace(/[^0-9.]/g, '');
    const dotIdx = rawChars.indexOf('.');
    if (dotIdx !== -1) {
        rawChars = rawChars.slice(0, dotIdx + 1) + rawChars.slice(dotIdx + 1).replace(/\./g, '');
    }

    // Build formatted string
    const parts      = rawChars.split('.');
    const intPart    = parts[0] ? formatIndianInteger(parts[0]) : '';
    const formatted  = parts.length > 1 ? intPart + '.' + (parts[1] || '') : intPart;

    input.value = formatted;

    // Restore cursor, accounting for added/removed commas
    const rawBeforeCursor    = rawChars.slice(0, cursorPos - commasBefore);
    const intBeforeCursor    = rawBeforeCursor.split('.')[0];
    const newCommasBefore    = (formatIndianInteger(intBeforeCursor).match(/,/g) || []).length;
    const newCursor          = cursorPos - commasBefore + newCommasBefore;
    try { input.setSelectionRange(newCursor, newCursor); } catch (_) {}

    return parseFloat(rawChars) || 0;
}

export function formatValue(key, value, configSchemas) {
    if (!isFinite(value) || value === null || value === undefined) return "0";

    let isPercentage = false;

    // Safely check dynamic formulas if they are passed in
    if (configSchemas) {
        const metricDef = configSchemas.metricsFormulas?.find(m => m.key === key);
        if (metricDef && metricDef.isPercentage) isPercentage = true;

        const ratioKey = key.startsWith('cr__') ? key.replace('cr__', '') : key;
        const ratioDef = configSchemas.customRatios?.find(r => r.key === ratioKey);
        if (ratioDef && ratioDef.isPercentage) isPercentage = true;
    } 
    // Fallback for base hardcoded ratios if configs aren't passed yet
    else if (key.toLowerCase().includes('margin') || key === 'roe') {
        isPercentage = true;
    }

    if (isPercentage) {
        return Number(value).toFixed(1) + "%";
    }

    // Indian number formatting (lakhs / crores)
    return formatIN(value);
}