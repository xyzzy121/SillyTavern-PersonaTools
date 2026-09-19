import { randomUUID } from 'node:crypto';
import { test, expect, loadFixture, nextPaint } from './helpers.js';

const fantasy = { id: 'fantasy', name: 'Fantasy', color: '#aaccee' };
const settings = (overrides = {}) => ({
    personaGroups: {}, folderDescriptions: {}, persona_tags: [fantasy], persona_tag_map: {}, ...overrides,
});

async function boot(page, data = settings(), extra = {}) {
    await loadFixture(page, { extensionSettings: { PersonaTools: data }, ...extra });
}

async function chooseTag(page) {
    if (!await page.locator('.pt-tag-bar').isVisible()) await page.locator('.pt-tag-bar-toggle').click();
    await page.locator('.pt-tag-bar-chips').getByRole('button', { name: /^Fantasy/ }).click();
}

async function prepareTwoRefreshes(page) {
    const personas = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${String(i).padStart(2, '0')}.png`, `Person ${i}`]));
    await boot(page, settings({ persona_tag_map: Object.fromEntries(Object.keys(personas).map(id => [id, ['fantasy']])) }), { personas });
    await page.locator('#next-page').click();
    await expect.poll(() => page.evaluate(() => PTFixture.page)).toBe(2);
    await page.evaluate(() => { PTFixture.deferRenders = true; });
    await chooseTag(page);
    await expect.poll(() => page.evaluate(() => PTFixture.pendingRenders.length)).toBe(1);
    await chooseTag(page);
    await expect.poll(() => page.evaluate(() => PTFixture.pendingRenders.length)).toBe(2);
}

for (const newestFirst of [false, true]) {
    test(`latest view keeps root page two when ${newestFirst ? 'newer' : 'older'} refresh finishes first`, async ({ page }) => {
        await prepareTwoRefreshes(page);
        await page.evaluate(index => PTFixture.resolveRender(index), newestFirst ? 1 : 0);
        await nextPaint(page);
        await page.evaluate(() => PTFixture.resolveRender());
        await expect.poll(() => page.evaluate(() => PTFixture.page)).toBe(2);
        await expect(page.locator('.avatar-container')).toHaveCount(5);
        await expect(page.locator('#pt-list-error')).toBeHidden();
    });
}

test('an older failed request cannot replace a newer successful view with an error', async ({ page }) => {
    await prepareTwoRefreshes(page);
    await page.evaluate(() => PTFixture.resolveRender(1));
    await expect.poll(() => page.evaluate(() => PTFixture.page)).toBe(2);
    await page.evaluate(() => PTFixture.resolveRender(0, true));
    await nextPaint(page);
    await expect(page.locator('#pt-list-error')).toBeHidden();
    await expect(page.locator('#user_avatar_block')).toBeVisible();
    await expect.poll(() => page.evaluate(() => PTFixture.page)).toBe(2);
});

test('an older success cannot dismiss the latest failure or expose stale cards', async ({ page }) => {
    await prepareTwoRefreshes(page);
    await page.evaluate(() => PTFixture.resolveRender(1, true));
    await expect(page.locator('#pt-list-error')).toBeVisible();
    await page.evaluate(() => PTFixture.resolveRender());
    await nextPaint(page);
    await expect(page.locator('#pt-list-error')).toBeVisible();
    await expect(page.locator('#user_avatar_block')).toBeHidden();
    await expect(page.locator('#persona_pagination_container')).toBeHidden();
    await page.evaluate(() => { PTFixture.deferRenders = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('#pt-list-error')).toBeHidden();
    await expect(page.locator('#user_avatar_block')).toBeVisible();
    await expect.poll(() => page.evaluate(() => PTFixture.page)).toBe(2);
});

for (const failure of ['reject', 'undefined', 'null', 'object']) {
    test(`a ${failure} native response hides stale results and retries the selected folder`, async ({ page }) => {
        await boot(page, settings({ personaGroups: { 'alice.png': ['Work'], 'bob.png': ['Work'] } }));
        await page.evaluate(failure => { PTFixture.renderFailure = failure; }, failure);
        await page.locator('.pt-folder-card[data-folder="Work"]').click();
        const error = page.locator('#pt-list-error');
        await expect(error).toBeVisible();
        await expect(error.getByRole('alert').or(error.getByRole('status'))).toBeVisible();
        await expect(page.locator('#user_avatar_block')).toBeHidden();
        await expect(page.locator('#persona_pagination_container')).toBeHidden();
        expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
        await page.evaluate(() => { PTFixture.renderFailure = null; });
        await error.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(error).toBeHidden();
        await expect(page.locator('.pt-folder-header')).toContainText('Work');
        await expect.poll(() => page.evaluate(() => PTFixture.filtered)).toEqual(['alice.png', 'bob.png']);
        await expect(page.locator('.avatar-container')).toHaveCount(2);
    });
}

test('duplicating a grouped current persona from the root reveals its inherited folder', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, persona_tag_map: { 'alice.png': ['fantasy'] } }));
    await expect(page.locator('.pt-folder-card[data-folder="Work"]')).toBeVisible();
    await page.evaluate(() => PTFixture.duplicate('alice.png', 'alice-copy.png'));
    await expect(page.locator('.pt-folder-header')).toBeVisible();
    await expect(page.locator('.pt-folder-header')).toContainText('Work');
    await expect(page.locator('.avatar-container[data-avatar-id="alice-copy.png"]')).toBeVisible();
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.persona_tag_map['alice-copy.png'])).toEqual(['fantasy']);
});

test('duplicating the current persona clears an excluding tag but keeps its folder', async ({ page }) => {
    await boot(page, settings({
        personaGroups: { 'alice.png': ['Work'], 'bob.png': ['Work'] },
        persona_tags: [fantasy, { id: 'hero', name: 'Hero', color: '#ffdbaa' }],
        persona_tag_map: { 'alice.png': ['hero'], 'bob.png': ['fantasy'] },
    }));
    await page.locator('.pt-folder-card[data-folder="Work"]').click();
    await chooseTag(page);
    await expect.poll(() => page.evaluate(() => PTFixture.filtered)).toEqual(['bob.png']);
    await page.evaluate(() => PTFixture.duplicate('alice.png', 'copy.png'));
    await expect(page.locator('.pt-folder-header')).toContainText('Work');
    await expect(page.locator('.pt-tag-bar-chips button').filter({ hasText: 'Fantasy' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.avatar-container[data-avatar-id="copy.png"]')).toBeVisible();
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.personaGroups['copy.png'])).toEqual(['Work']);
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.persona_tag_map['copy.png'])).toEqual(['hero']);
});

test('an out-of-folder duplicate opens its inherited folder so the copy remains visible', async ({ page }) => {
    await boot(page, settings({
        personaGroups: { 'alice.png': ['Work'], 'bob.png': ['Home'] },
        persona_tag_map: { 'bob.png': ['fantasy'] },
    }));
    await page.locator('.pt-folder-card[data-folder="Home"]').click();
    await chooseTag(page);
    await expect.poll(() => page.evaluate(() => PTFixture.filtered)).toEqual(['bob.png']);
    await page.evaluate(() => PTFixture.duplicate('alice.png', 'copy.png'));
    await expect(page.locator('.pt-folder-header')).toContainText('Work');
    await expect(page.locator('.avatar-container[data-avatar-id="copy.png"]')).toBeVisible();
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.personaGroups['copy.png'])).toEqual(['Work']);
});

async function quickPixel(page) {
    return page.locator('#quickPersonaImg').evaluate(async img => {
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(0, 0, 1, 1).data];
    });
}

for (const emptyView of [false, true]) {
    test(`a same-ID avatar update refreshes the cached quick image with ${emptyView ? 'zero' : 'visible'} native results`, async ({ page }) => {
        await boot(page, settings(), { personas: { 'alice.png': 'Alice' }, avatarCacheKey: randomUUID() });
        await expect.poll(() => quickPixel(page)).toEqual([255, 0, 0, 255]);
        if (emptyView) {
            await chooseTag(page);
            await expect(page.locator('.avatar-container')).toHaveCount(0);
            await nextPaint(page);
        }
        await page.evaluate(async () => {
            await PTFixture.reloadAvatarImage('alice.png', 1);
            PTFixture.emit('PERSONA_UPDATED', 'alice.png');
            await PTFixture.getUserAvatars(true);
        });
        await expect.poll(() => quickPixel(page)).toEqual([0, 0, 255, 255]);
        if (emptyView) await expect(page.locator('.avatar-container')).toHaveCount(0);
    });
}

test('an unrelated render during avatar upload does not consume the eventual image refresh', async ({ page }) => {
    await boot(page, settings({ persona_tag_map: { 'alice.png': ['fantasy'] } }), {
        personas: { 'alice.png': 'Alice' }, avatarCacheKey: randomUUID(),
    });
    await expect.poll(() => quickPixel(page)).toEqual([255, 0, 0, 255]);
    await page.evaluate(() => { PTFixture.deferRenders = true; });
    await chooseTag(page);
    await expect.poll(() => page.evaluate(() => PTFixture.pendingRenders.length)).toBe(1);
    await page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'avatar_upload_file';
        document.body.append(input);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        PTFixture.resolveRender();
    });
    await nextPaint(page);
    await expect.poll(() => quickPixel(page)).toEqual([255, 0, 0, 255]);
    await page.evaluate(async () => {
        await PTFixture.reloadAvatarImage('alice.png', 1);
        PTFixture.deferRenders = false;
        // The native Change image path rebuilds cards without PERSONA_UPDATED.
        await PTFixture.getUserAvatars(true);
    });
    await expect.poll(() => quickPixel(page)).toEqual([0, 0, 255, 255]);
});

test('metadata keystrokes do not rebind the quick image or refetch its cached thumbnail', async ({ page }) => {
    const key = randomUUID();
    await boot(page, settings(), { personas: { 'alice.png': 'Alice' }, avatarCacheKey: key });
    await expect.poll(() => quickPixel(page)).toEqual([255, 0, 0, 255]);
    await nextPaint(page);
    const before = await page.evaluate(async key => (await (await fetch(`/fixture/avatar-cache?key=${key}`)).json()).requests, key);
    await page.evaluate(() => {
        window.fixtureImageRebinds = 0;
        new MutationObserver(records => { window.fixtureImageRebinds += records.length; })
            .observe(document.getElementById('quickPersonaImg'), { attributes: true, attributeFilter: ['src'] });
        for (let i = 0; i < 20; i++) PTFixture.emit('PERSONA_UPDATED', 'alice.png');
    });
    await nextPaint(page);
    expect(await page.evaluate(() => window.fixtureImageRebinds)).toBe(0);
    const after = await page.evaluate(async key => (await (await fetch(`/fixture/avatar-cache?key=${key}`)).json()).requests, key);
    expect(after).toBe(before);
});

test('the native grid class lays out folder tiles and leaves per-card actions operable', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] } }));
    await page.locator('#grid-toggle').click();
    await expect(page.locator('#user_avatar_block')).toHaveClass(/gridView/);
    const folder = page.locator('.pt-folder-card[data-folder="Work"]');
    expect((await folder.boundingBox()).width).toBeLessThanOrEqual(101);
    await folder.getByRole('button', { name: 'Edit folder', exact: true }).press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.avatar-container[data-avatar-id="bob.png"]').getByRole('button', { name: 'Tags', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
});
