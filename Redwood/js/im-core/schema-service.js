// js/im-core/schema-service.js

import { db } from '../firebase.js';
import { generateId } from './utils.js';
import {
    doc, getDoc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const DEFAULT_SCHEMA_KEY = 'im';
const getSchemaRef = (schemaKey = DEFAULT_SCHEMA_KEY) => doc(db, 'config', `${schemaKey}-schema`);

// ── Read (Single fetch for main workspace) ────────────────────────────────────
export async function loadSchema(imId, schemaKey = DEFAULT_SCHEMA_KEY) {
    try {
        const snap = await getDoc(getSchemaRef(schemaKey));
        if (snap.exists()) {
            const data = snap.data();
            if (Array.isArray(data.sections) && data.sections.length > 0) {
                return data.sections;
            }
        }
        return [];
    } catch (e) {
        console.error('[schema-service] loadSchema failed:', e);
        return [];
    }
}

// ── Multiplayer Real-Time Sync (For Schema Editor) ────────────────────────────
export function subscribeToSchema(imId, callback, schemaKey = DEFAULT_SCHEMA_KEY) {
    return onSnapshot(getSchemaRef(schemaKey), (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            if (Array.isArray(data.sections) && data.sections.length > 0) {
                callback(data.sections);
                return;
            }
        }
        callback([]); // Pass empty array if no schema exists yet
    }, (error) => {
        console.error('[schema-service] Real-time sync failed:', error);
    });
}

// ── Write (Directly to Cloud) ─────────────────────────────────────────────────
export async function saveSchema(imId, sections, schemaKey = DEFAULT_SCHEMA_KEY) {
    await setDoc(getSchemaRef(schemaKey), {
        sections,
        savedAt: new Date().toISOString()
    });
}

// ── Create blank section ──────────────────────────────────────────────────────
export function makeSection() {
    const id = generateId();
    return {
        id,
        key:      `section-${id}`,
        navLabel: 'New Section',
        heading:  'New Section',
        order:    0,
        blocks:   []
    };
}

export function makeSubsection(parentId) {
    const id = generateId();
    return {
        id,
        key:      `section-${id}`,
        navLabel: 'New Subsection',
        heading:  'New Subsection',
        order:    0,
        parentId,          // ← links to parent section
        blocks:   []
    };
}

// ── Create blank block of given type ─────────────────────────────────────────
export function makeBlock(type) {
    const id = generateId();
    const base = { id, type, order: 0 };

    switch (type) {
        case 'text':
        case 'textarea':
        case 'quill':
        case 'date':
        case 'number':
        case 'email':
            return { ...base, label: '', placeholder: '', guide: '', dataPath: '' };

        case 'checkbox':
            return { ...base, label: '', dataPath: '' };
            
        case 'select':
            return { ...base, label: '', placeholder: '', dataPath: '', options: ['Option 1'] };

        case 'mixed':
            return { ...base, label: '', dataPath: '', template: 'My [text] and [number]', options: [] };

        case 'instruction':
            return { ...base, label: 'Instructions', content: '', showCondition: '' };

        case 'h3':
        case 'h4':
        case 'divider':
            return { ...base, label: '' };

        case 'table-static':
            return {
                ...base,
                label:    '',
                dataPath: '',
                hasHeading: false,       
                headingFields: [],       
                rows: [],                
            };

        case 'table-repeating':
        case 'table':
            return {
                ...base,
                label:        '',
                dataPath:     '',
                dynamicRows:  true,
                baseRowCount: 1,
                columns: [
                    { id: generateId(), header: 'Column 1', inputType: 'text' },
                    { id: generateId(), header: 'Column 2', inputType: 'text' }
                ]
            };

        case 'image':
            return {
                ...base,
                label:    '',
                dataPath: '',
                multiple: false,
                maxWidth:  '100%',
                maxHeight: '',
            };

        case 'file':
            return {
                ...base,
                label:    '',
                dataPath: '',
                multiple: false,
            };

        default:
            return base;
    }
}
