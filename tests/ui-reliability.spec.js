import { test, expect, loadFixture as boot, nextPaint } from './helpers.js';

const personas = {
    'alice.png': 'Alice', 'bob.png': 'Bob', 'cara.png': 'Cara', 'dora.png': 'Dora',
    'erin.png': 'Erin', 'faye.png': 'Faye', 'gina.png': 'Gina',
};
const fantasy = { id: 'fantasy', name: 'Fantasy', color: '#aaccee' };

async function openTags(page) {
    await page.locator('.avatar-container').first().getByRole('button', { name: 'Tags', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await nextPaint(page);
}

async function insideViewport(page, locator) {
    await expect.poll(async () => locator.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft || 0;
        const top = viewport?.offsetTop || 0;
        return rect.left >= left + 6 && rect.top >= top + 6
            && rect.right <= left + (viewport?.width || innerWidth) - 6
            && rect.bottom <= top + (viewport?.height || innerHeight) - 6;
    })).toBe(true);
}

test('quick menu remains reachable after expanding a folder and resizing', async ({ page }) => {
    await boot(page, {
        personas,
        extensionSettings: { PersonaTools: {
            personaGroups: Object.fromEntries(Object.keys(personas).filter(id => id !== 'alice.png').map(id => [id, ['Friends']])),
        } },
    });
    await page.locator('#quickPersona').click();
    const menu = page.locator('#quickPersonaMenu');
    await menu.getByRole('menuitem', { name: /Friends/ }).click();
    await insideViewport(page, menu);
    await page.setViewportSize({ width: 390, height: 450 });
    await insideViewport(page, menu);
    const alice = menu.getByRole('menuitemradio', { name: 'Alice', exact: true });
    await alice.scrollIntoViewIfNeeded();
    await alice.click();
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual(['alice.png']);
    await expect(menu).toHaveCount(0);
});

test('an expanding dialog stays in the viewport after its card is rerendered', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 700 });
    await boot(page);
    await page.locator('.avatar-container').nth(2).getByRole('button', { name: 'Folders', exact: true }).click();
    const dialog = page.getByRole('dialog');
    for (let i = 0; i < 8; i++) {
        await dialog.getByRole('textbox', { name: 'New folder name', exact: true }).fill(`Folder ${i}`);
        await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    }
    await insideViewport(page, dialog);
    await page.setViewportSize({ width: 390, height: 360 });
    await insideViewport(page, dialog);
    const description = dialog.getByRole('textbox', { name: 'Folder description', exact: true });
    await description.scrollIntoViewIfNeeded();
    await description.fill('Still editable after the anchor disappears');
    await expect(description).toBeFocused();
});

test('overlays respond to a smaller visual viewport with an offset', async ({ page }) => {
    await boot(page, { personas });
    await page.evaluate(() => {
        const viewport = new EventTarget();
        Object.assign(viewport, { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await page.locator('#quickPersona').click();
    await page.evaluate(() => {
        Object.assign(window.visualViewport, { width: 340, height: 300, offsetLeft: 20, offsetTop: 100 });
        window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await insideViewport(page, page.locator('#quickPersonaMenu'));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.visualViewport.dispatchEvent(new Event('resize')));
    await expect(page.locator('#quickPersonaMenu')).toHaveCount(0);
});

test('quick search deduplicates memberships, restores groups, and explains no matches', async ({ page }) => {
    await boot(page, { personas, extensionSettings: { PersonaTools: { personaGroups: { 'alice.png': ['Home', 'Work'] } } } });
    await page.locator('#quickPersona').click();
    const menu = page.locator('#quickPersonaMenu');
    const search = menu.getByRole('searchbox', { name: 'Search personas' });
    await search.fill('Alice');
    await expect(menu.getByRole('menuitemradio', { name: 'Alice', exact: true })).toHaveCount(1);
    await expect(menu.getByRole('menuitem')).toHaveCount(0);
    await search.fill('Nobody matches');
    await expect(menu.getByRole('status')).toHaveText('No matching personas');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
    await search.fill('');
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await expect(menu.getByRole('menuitemradio', { name: 'Alice', exact: true })).toHaveCount(2);
    await expect(menu.getByRole('status')).toHaveCount(0);
});

test('clearing quick search restores each folder independently', async ({ page }) => {
    await boot(page, {
        personas,
        extensionSettings: { PersonaTools: {
            personaGroups: { 'alice.png': ['Home'], 'bob.png': ['Home', 'Work'], 'cara.png': ['Work'] },
        } },
    });
    await page.locator('#quickPersona').click();
    const menu = page.locator('#quickPersonaMenu');
    const home = menu.getByRole('menuitem', { name: /Home/ });
    const work = menu.getByRole('menuitem', { name: /Work/ });
    const search = menu.getByRole('searchbox');
    await home.click();
    await work.click();
    await search.fill('Bob');
    await expect(menu.getByRole('menuitemradio', { name: 'Bob', exact: true })).toHaveCount(1);
    await search.clear();
    await expect(home).toHaveAttribute('aria-expanded', 'false');
    await expect(work).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Alice', exact: true })).toHaveCount(0);
    await expect(menu.getByRole('menuitemradio', { name: 'Bob', exact: true })).toHaveCount(1);
    await expect(menu.getByRole('menuitemradio', { name: 'Cara', exact: true })).toHaveCount(1);
    await home.click();
    await work.click();
    await search.fill('Bob');
    await search.clear();
    await expect(home).toHaveAttribute('aria-expanded', 'true');
    await expect(work).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('menuitemradio', { name: 'Alice', exact: true })).toHaveCount(1);
    await expect(menu.getByRole('menuitemradio', { name: 'Bob', exact: true })).toHaveCount(1);
    await expect(menu.getByRole('menuitemradio', { name: 'Cara', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
});

test('quick menu announces empty lists and recoverable loading failures', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { PTFixture.deferAvatars = true; });
    await page.locator('#quickPersona').click();
    await expect(page.locator('#pt-quick-status')).toHaveText('Loading personas…');
    await page.evaluate(() => PTFixture.resolveAvatars(0, true));
    await expect(page.locator('#pt-quick-status')).toContainText('Could not load personas');
    await expect(page.locator('#quickPersona')).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => { PTFixture.deferAvatars = false; PTFixture.avatars = []; });
    await page.locator('#quickPersona').click();
    await expect(page.locator('#quickPersonaMenu').getByRole('status')).toHaveText('No personas available');
    await expect(page.locator('#pt-quick-status')).toBeEmpty();
    await page.keyboard.press('Escape');
    await expect(page.locator('#pt-quick-status')).toHaveCount(1);
});

test('a selection failure is announced and allows the user to reopen the switcher', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { PTFixture.selectAvatar = async () => { throw new Error('Selection failed'); }; });
    await page.locator('#quickPersona').click();
    await page.locator('#quickPersonaMenu').getByRole('menuitemradio', { name: 'Bob', exact: true }).click();
    await expect(page.locator('#pt-quick-status')).toContainText('Could not switch persona');
    await page.locator('#quickPersona').click();
    await expect(page.locator('#quickPersonaMenu')).toBeVisible();
    await expect(page.locator('#pt-quick-status')).toBeEmpty();
});

for (const form of ['folder', 'tag']) {
    test(`composing Enter and Escape preserve the ${form} form`, async ({ page }) => {
        await boot(page);
        await page.locator('.avatar-container').first().getByRole('button', { name: form === 'folder' ? 'Folders' : 'Tags', exact: true }).click();
        await nextPaint(page);
        const input = page.getByRole('dialog').getByRole('textbox', { name: form === 'folder' ? 'New folder name' : 'New tag name', exact: true });
        await input.fill('とうきょう');
        for (const key of ['Enter', 'Escape']) {
            await input.dispatchEvent('keydown', { key, isComposing: true, keyCode: 229, bubbles: true });
            await expect(page.getByRole('dialog')).toBeVisible();
            await expect(input).toHaveValue('とうきょう');
        }
        const saved = await page.evaluate(() => PTFixture.extensionSettings.PersonaTools);
        expect(saved.personaGroups).toEqual({});
        expect(saved.persona_tags).toEqual([]);
        await input.press('Enter');
        await expect(input).toHaveValue('');
        expect(await page.evaluate(kind => kind === 'folder'
            ? PTFixture.extensionSettings.PersonaTools.personaGroups['alice.png'].length
            : PTFixture.extensionSettings.PersonaTools.persona_tags.length, form)).toBe(1);
    });
}

test('composing Escape keeps the quick menu and search text', async ({ page }) => {
    await boot(page, { personas });
    await page.locator('#quickPersona').click();
    const search = page.locator('#quickPersonaMenu').getByRole('searchbox');
    await search.fill('とうきょう');
    await search.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true });
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('とうきょう');
    await page.keyboard.press('Escape');
    await expect(page.locator('#quickPersonaMenu')).toHaveCount(0);
});

test('Chromium IME composition keeps candidate confirmation inside the tag input', async ({ page }) => {
    await boot(page);
    await openTags(page);
    const input = page.getByRole('dialog').getByRole('textbox', { name: 'New tag name' });
    await input.focus();
    const session = await page.context().newCDPSession(page);
    await session.send('Input.imeSetComposition', { text: 'とうきょう', selectionStart: 5, selectionEnd: 5 });
    await expect(input).toHaveValue('とうきょう');
    await input.press('Enter');
    await expect(input).toHaveValue('とうきょう');
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.persona_tags)).toEqual([]);
    await input.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();
    await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await session.detach();
});

for (const kind of ['tag', 'folder']) {
    test(`holding Enter cannot complete ${kind} deletion`, async ({ page }) => {
        await boot(page, { extensionSettings: { PersonaTools: {
            persona_tags: [fantasy], persona_tag_map: { 'alice.png': ['fantasy'] },
            personaGroups: { 'bob.png': ['Work'] },
        } } });
        if (kind === 'tag') await openTags(page);
        else {
            await page.locator('.pt-folder-edit').click();
            await nextPaint(page);
        }
        const button = page.getByRole('dialog').getByRole('button', { name: kind === 'tag' ? 'Delete Fantasy everywhere' : 'Delete folder', exact: true });
        await button.focus();
        await page.keyboard.down('Enter');
        await page.keyboard.down('Enter');
        await page.keyboard.up('Enter');
        expect(await page.evaluate(value => value === 'tag'
            ? PTFixture.extensionSettings.PersonaTools.persona_tags.length
            : Object.keys(PTFixture.extensionSettings.PersonaTools.personaGroups).length, kind)).toBe(1);
        await page.keyboard.press('Enter');
        expect(await page.evaluate(value => value === 'tag'
            ? PTFixture.extensionSettings.PersonaTools.persona_tags.length
            : Object.keys(PTFixture.extensionSettings.PersonaTools.personaGroups).length, kind)).toBe(0);
    });
}

for (const kind of ['tag', 'folder']) {
    const countSaved = page => page.evaluate(value => value === 'tag'
        ? PTFixture.extensionSettings.PersonaTools.persona_tags.length
        : Object.keys(PTFixture.extensionSettings.PersonaTools.personaGroups).length, kind);
    const openConfirmation = async page => {
        if (kind === 'tag') await openTags(page);
        else {
            await page.locator('.pt-folder-edit').click();
            await nextPaint(page);
        }
        return page.getByRole('dialog').locator(kind === 'tag' ? '.pt-chip-delete' : '.pt-danger-btn');
    };
    const seed = { extensionSettings: { PersonaTools: {
        persona_tags: [fantasy], persona_tag_map: { 'alice.png': ['fantasy'] },
        personaGroups: { 'bob.png': ['Work'] },
    } } };

    test(`${kind} deletion expires and requires two fresh activations`, async ({ page }) => {
        await boot(page, seed);
        const button = await openConfirmation(page);
        await page.clock.install();
        await button.click();
        await expect(button).toHaveClass(/pt-armed/);
        await page.clock.fastForward(3001);
        await expect(button).not.toHaveClass(/pt-armed/);
        await expect(button).toHaveAccessibleName(kind === 'tag' ? 'Delete Fantasy everywhere' : 'Delete folder');
        await button.click();
        expect(await countSaved(page)).toBe(1);
        await expect(button).toHaveClass(/pt-armed/);
        await button.click();
        expect(await countSaved(page)).toBe(0);
    });

    test(`closing the ${kind} dialog disposes its armed confirmation`, async ({ page }) => {
        await boot(page, seed);
        const button = await openConfirmation(page);
        const oldButton = await button.elementHandle();
        await page.clock.install();
        await button.click();
        await expect(button).toHaveClass(/pt-armed/);
        await page.keyboard.press('Escape');
        expect(await oldButton.evaluate(node => ({ connected: node.isConnected, armed: node.classList.contains('pt-armed') })))
            .toEqual({ connected: false, armed: false });
        await oldButton.evaluate(node => node.click());
        await page.clock.fastForward(3001);
        expect(await countSaved(page)).toBe(1);
        const reopened = await openConfirmation(page);
        await reopened.click();
        await expect(reopened).toHaveClass(/pt-armed/);
        expect(await countSaved(page)).toBe(1);
    });
}

test('rerendering tags disposes old confirmations and leaves fresh controls unarmed', async ({ page }) => {
    await boot(page, { extensionSettings: { PersonaTools: {
        persona_tags: [fantasy], persona_tag_map: { 'alice.png': ['fantasy'] },
    } } });
    await openTags(page);
    const dialog = page.getByRole('dialog');
    const button = dialog.locator('.pt-chip-delete');
    const oldButton = await button.elementHandle();
    await page.clock.install();
    await button.click();
    await expect(button).toHaveClass(/pt-armed/);
    await dialog.getByRole('button', { name: 'Fantasy', exact: true }).click();
    expect(await oldButton.evaluate(node => ({ connected: node.isConnected, armed: node.classList.contains('pt-armed') })))
        .toEqual({ connected: false, armed: false });
    await oldButton.evaluate(node => node.click());
    await page.clock.fastForward(3001);
    await expect(button).not.toHaveClass(/pt-armed/);
    await expect(button).toHaveAccessibleName('Delete Fantasy everywhere');
    await button.click();
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.persona_tags.length)).toBe(1);
    await button.click();
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.persona_tags.length)).toBe(0);
});

test('dialog keyboard events do not activate background chat shortcuts', async ({ page }) => {
    await boot(page);
    await page.locator('#chat-input').fill('An unsent message');
    await openTags(page);
    const input = page.getByRole('dialog').getByRole('textbox', { name: 'New tag name' });
    await input.fill('New tag');
    await input.press('Control+Enter');
    await input.press('Alt+Enter');
    expect(await page.evaluate(() => PTFixture.backgroundShortcuts)).toEqual({ send: 0, regenerate: 0, continue: 0 });
    await page.keyboard.press('Escape');
    await page.locator('#chat-input').focus();
    await page.keyboard.press('Control+Enter');
    expect(await page.evaluate(() => PTFixture.backgroundShortcuts.send)).toBe(1);
});

test('long tag names stay within list, grid, and dialog controls', async ({ page }) => {
    const name = 'LongTag'.repeat(70);
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, { extensionSettings: { PersonaTools: {
        persona_tags: [{ ...fantasy, name }], persona_tag_map: { 'alice.png': ['fantasy'] },
    } } });
    const tagArea = page.locator('.pt-card-tags');
    const fits = locator => expect.poll(() => locator.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await fits(tagArea);
    await page.locator('#grid-toggle').click();
    await expect(page.locator('#user_avatar_block')).toHaveClass(/gridView/);
    await fits(tagArea);
    await openTags(page);
    for (const group of await page.getByRole('dialog').locator('.pt-chip-group').all()) await fits(group);
    const del = page.getByRole('dialog').locator('.pt-chip-delete');
    await expect(del).toHaveAccessibleName(`Delete ${name} everywhere`);
    await del.scrollIntoViewIfNeeded();
    await del.click();
    await expect(del).toHaveAttribute('aria-label', `Confirm delete ${name} everywhere`);
});

test.describe('touch dialogs', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test('input and backdrop taps preserve the underlying drawer', async ({ page }) => {
        await boot(page, { extensionSettings: { PersonaTools: { persona_tags: [fantasy] } } });
        // SillyTavern transforms a root element with no in-flow height. Fixed
        // inset-only backdrops would collapse to zero height in this host shape.
        await page.evaluate(() => {
            document.documentElement.style.transform = 'translateZ(0)';
            document.documentElement.style.height = '0px';
        });
        await page.locator('.avatar-container').first().getByRole('button', { name: 'Tags', exact: true }).tap();
        await page.getByRole('dialog').getByRole('textbox', { name: 'New tag name' }).tap();
        expect(await page.evaluate(() => PTFixture.drawerOpen)).toBe(true);
        expect(await page.locator('.pt-backdrop').evaluate(node => node.getBoundingClientRect().height)).toBe(844);
        expect(await page.evaluate(() => document.elementFromPoint(2, 2)?.classList.contains('pt-backdrop'))).toBe(true);
        await page.touchscreen.tap(2, 2);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(await page.evaluate(() => ({ open: PTFixture.drawerOpen, dismissals: PTFixture.drawerDismissals })))
            .toEqual({ open: true, dismissals: 0 });
    });
});
