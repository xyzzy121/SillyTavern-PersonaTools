import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serve the production assets verbatim. Only the host modules and markup are
// fixtures; tests never rewrite, extract, or reimplement extension functions.
const routes = new Map([
    ['/', ['fixture.html', 'text/html']],
    ['/fixture.js', ['fixture.js', 'text/javascript']],
    ['/index.js', ['../index.js', 'text/javascript']],
    ['/style.css', ['../style.css', 'text/css']],
]);
const modules = new Map([
    ['/script.js', 'export const settings = window.PTFixture.legacySettings;'],
    ['/scripts/power-user.js', 'export const power_user = window.PTFixture.powerUser;'],
    ['/scripts/personas.js', `
        export const personasFilter = window.PTFixture.filter;
        export let user_avatar = window.PTFixture.currentAvatar;
        export async function getUserAvatars(doRender = true) {
            return window.PTFixture.getUserAvatars(doRender);
        }
        export async function setUserAvatar(id) {
            user_avatar = id;
            await window.PTFixture.selectAvatar(id);
        }
        export function isPersonaPanelOpen() { return window.PTFixture.drawerOpen; }
    `],
]);
const avatar = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#486b91"/><circle cx="32" cy="25" r="12" fill="#eee"/><path d="M10 60Q10 38 32 38Q54 38 54 60" fill="#eee"/></svg>';
// Test-specific keys isolate the real browser HTTP caches and server revisions
// between parallel pages. Only synthetic SVG pixels live in this in-memory map.
const avatarCaches = new Map();

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (path === '/fixture/avatar-cache' || path === '/fixture/cached-avatar.svg') {
            const key = url.searchParams.get('key') || '';
            if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) {
                res.writeHead(400);
                res.end('Invalid fixture cache key');
                return;
            }
            const state = avatarCaches.get(key) || { revision: 0, requests: 0 };
            avatarCaches.set(key, state);
            if (path === '/fixture/avatar-cache') {
                if (req.method === 'POST') {
                    const revision = Number(url.searchParams.get('revision'));
                    if (!Number.isInteger(revision) || revision < 0 || revision > 10) {
                        res.writeHead(400);
                        res.end('Invalid fixture revision');
                        return;
                    }
                    state.revision = revision;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(state));
            } else {
                state.requests++;
                const color = state.revision % 2 ? '#0000ff' : '#ff0000';
                res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
                res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${color}"/></svg>`);
            }
        } else if (modules.has(path)) {
            res.writeHead(200, { 'Content-Type': 'text/javascript' });
            res.end(modules.get(path));
        } else if (path.startsWith('/avatars/') || path.startsWith('/img/')) {
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end(avatar);
        } else if (routes.has(path)) {
            const [file, type] = routes.get(path);
            const content = await readFile(new URL(file, import.meta.url));
            res.writeHead(200, { 'Content-Type': type });
            res.end(content);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    } catch (error) {
        res.writeHead(500);
        res.end(error.message);
    }
}

export async function startFixtureServer() {
    avatarCaches.clear();
    const server = createServer(handleRequest);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(4179, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    return server;
}

// Direct execution remains useful for manually inspecting the fixture. Tests
// import the server into their setup process so teardown needs no shell tools.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    await startFixtureServer();
}
