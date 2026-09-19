import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const scriptExtension = /\.(?:js|mjs|cjs)$/;
const generatedDirectories = new Set(['node_modules', 'test-results', 'playwright-report', '.git']);

async function scriptFiles(directory, recursive = false) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async entry => {
        const path = join(directory, entry.name);
        if (entry.isFile() && scriptExtension.test(entry.name)) return [path];
        if (recursive && entry.isDirectory() && !generatedDirectories.has(entry.name)) return scriptFiles(path, true);
        return [];
    }));
    return files.flat();
}

// Restrict discovery to source/test/tool locations. Dependencies, browser
// reports, traces, and other generated directories are never traversed.
const files = (await Promise.all([
    scriptFiles(root),
    scriptFiles(join(root, 'tests'), true),
    scriptFiles(join(root, 'scripts'), true),
])).flat().sort();

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
        console.error(`Syntax check failed: ${relative(root, file)}`);
        if (result.error) console.error(result.error.message);
        process.exitCode = 1;
    }
}

if (!process.exitCode) console.log(`Syntax checked ${files.length} JavaScript files.`);
