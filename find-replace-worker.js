/**
 * Compute a find-and-replace preview away from the UI thread. The caller owns
 * the worker's lifetime and terminates it if a pattern exceeds its time limit.
 * No persona data is written here.
 */
'use strict';

self.onmessage = ({ data }) => {
    try {
        const { personas, find, replacement, matchCase, useRegex } = data;
        if (!find) throw new Error('Enter text or a regular expression to find.');

        const pattern = useRegex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const expression = new RegExp(pattern, matchCase ? 'g' : 'gi');
        const changes = [];
        const invalidNames = [];
        let matchCount = 0;
        let fieldCount = 0;

        for (const persona of personas) {
            const fields = [];
            for (const [field, before] of Object.entries(persona.fields)) {
                // matchAll advances after empty matches, including at the end
                // of a string, so patterns such as ^ and (?=x) cannot loop.
                let matches = 0;
                for (const ignored of before.matchAll(expression)) {
                    matches++;
                }
                matchCount += matches;
                if (!matches) continue;

                // A callback preserves replacement tokens literally in text
                // mode; the string form retains JavaScript capture semantics.
                const after = before.replace(expression, useRegex ? replacement : () => replacement);
                if (after === before) continue;

                fields.push({ field, before, after, matches });
                fieldCount++;
                if (field === 'name' && !after.trim()) {
                    invalidNames.push({ id: persona.id, name: persona.name });
                }
            }
            if (fields.length) changes.push({ id: persona.id, name: persona.name, fields });
        }

        self.postMessage({ changes, matchCount, fieldCount, personaCount: changes.length, invalidNames });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
