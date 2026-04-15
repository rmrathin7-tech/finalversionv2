// js/fsa/utils/formatters.js

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

    // Standard number formatting with commas
    return Number(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}