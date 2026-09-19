import { test, expect, loadFixture, waitForFixture } from './helpers.js';

const fantasy = { id: 'fantasy', name: 'Fantasy', color: '#aaccee' };
const hero = { id: 'hero', name: 'Hero', color: '#ffdbaa' };
const settings = (overrides = {}) => ({
    personaGroups: {}, folderDescriptions: {}, persona_tags: [fantasy, hero], persona_tag_map: {}, ...overrides,
});
const card = (page, id) => page.locator(`.avatar-container[data-avatar-id="${id}"]`);
const dialog = page => page.getByRole('dialog');
const filtered = page => page.evaluate(() => PTFixture.filtered);

async function boot(page, data, extra = {}) {
    await loadFixture(page, { extensionSettings: { PersonaTools: data }, ...extra });
}

async function chooseTag(page, name = 'Fantasy') {
    if (!await page.locator('.pt-tag-bar').isVisible()) await page.locator('.pt-tag-bar-toggle').click();
    await page.locator('.pt-tag-bar-chips').getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

async function openTags(page, id = 'alice.png') {
    await card(page, id).getByRole('button', { name: 'Tags', exact: true }).click();
    await expect(dialog(page)).toBeVisible();
}

for (const viaAvailable of [false, true]) {
    test(`removing a selected tag refreshes results via ${viaAvailable ? 'available' : 'assigned'} control`, async ({ page }) => {
        await boot(page, settings({ persona_tag_map: { 'alice.png': ['fantasy'], 'bob.png': ['fantasy'] } }));
        await chooseTag(page);
        await openTags(page);
        await dialog(page).getByRole('button', { name: viaAvailable ? 'Fantasy' : 'Remove Fantasy from persona', exact: true }).click();
        await expect.poll(() => filtered(page)).toEqual(['bob.png']);
        await expect(card(page, 'alice.png')).toHaveCount(0);
        await expect(page.locator('.pt-tag-bar-chips')).toContainText('Fantasy1');
        await page.keyboard.press('Escape');
        await expect(page.locator('#persona-management-block')).toBeFocused();
    });
}

test('AND filters update after removing one selected tag and adding it back', async ({ page }) => {
    await boot(page, settings({ persona_tag_map: { 'alice.png': ['fantasy', 'hero'], 'bob.png': ['fantasy'] } }));
    await chooseTag(page);
    await chooseTag(page, 'Hero');
    await expect.poll(() => filtered(page)).toEqual(['alice.png']);
    await openTags(page);
    const available = dialog(page).getByRole('button', { name: 'Hero', exact: true });
    await available.click();
    await expect.poll(() => filtered(page)).toEqual([]);
    await expect(available).toBeFocused();
    await available.press('Enter');
    await expect.poll(() => filtered(page)).toEqual(['alice.png']);
    await expect(available).toHaveAttribute('aria-pressed', 'true');
    await expect(available).toBeFocused();
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
});

for (const size of [6, 11]) {
    test(`filtered pagination preserves or clamps page two with ${size} starting matches`, async ({ page }) => {
        const personas = Object.fromEntries(Array.from({ length: size }, (_, i) => [`p${String(i).padStart(2, '0')}.png`, `Person ${String(i).padStart(2, '0')}`]));
        await boot(page, settings({ persona_tag_map: Object.fromEntries(Object.keys(personas).map(id => [id, ['fantasy']])) }), { personas });
        await chooseTag(page);
        await page.locator('#next-page').click();
        await openTags(page, 'p05.png');
        await dialog(page).getByRole('button', { name: 'Remove Fantasy from persona' }).click();
        await expect.poll(() => page.evaluate(() => ({ page: PTFixture.page, count: PTFixture.filtered.length })))
            .toEqual({ page: size === 6 ? 1 : 2, count: size - 1 });
        await expect(page.locator('.avatar-container')).toHaveCount(5);
    });
}

test('folder breadcrumb stays visible with tags; search and Back preserve the intended scope', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'], 'bob.png': ['Home'] }, persona_tag_map: { 'alice.png': ['fantasy'], 'bob.png': ['fantasy'] } }));
    await page.locator('.pt-folder-card[data-folder="Work"]').click();
    await chooseTag(page);
    await expect(page.locator('.pt-folder-header')).toBeVisible();
    await expect.poll(() => filtered(page)).toEqual(['alice.png']);
    await page.locator('#persona_search_bar').fill('Bob');
    await expect.poll(() => filtered(page)).toEqual(['bob.png']);
    await expect(page.locator('.pt-folder-header')).toBeHidden();
    await page.locator('#persona_search_bar').fill('');
    await expect.poll(() => filtered(page)).toEqual(['alice.png']);
    await expect(page.locator('.pt-folder-header')).toBeVisible();
    await page.getByRole('button', { name: 'Back to all personas' }).click();
    await expect.poll(() => filtered(page)).toEqual(['alice.png', 'bob.png']);
    await expect(page.locator('.pt-tag-bar-chips button').filter({ hasText: 'Fantasy' })).toHaveAttribute('aria-pressed', 'true');
});

test('folder dialog contains Tab and restores checkbox focus across assignment renders', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'], 'bob.png': ['Work', 'Home'] } }));
    await page.locator('.pt-folder-card[data-folder="Work"]').click();
    await card(page, 'alice.png').getByRole('button', { name: 'Folders', exact: true }).click();
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    const checkbox = dialog(page).getByRole('checkbox', { name: 'Work', exact: true });
    await checkbox.focus();
    await checkbox.press('Space');
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeFocused();
    await expect(card(page, 'alice.png')).toHaveCount(0);
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();
    await expect(card(page, 'alice.png')).toHaveCount(1);
    const close = dialog(page).getByRole('button', { name: 'Close', exact: true });
    await close.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog(page).getByRole('textbox', { name: 'Folder description' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(card(page, 'alice.png').getByRole('button', { name: 'Folders', exact: true })).toBeFocused();
});

test('tag dialog has sibling delete buttons and preserves focus for repeated keyboard toggles', async ({ page }) => {
    await boot(page, settings());
    await openTags(page);
    const toggle = dialog(page).getByRole('button', { name: 'Fantasy', exact: true });
    await expect(toggle).toBeFocused();
    await expect(dialog(page).locator('button button')).toHaveCount(0);
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toBeFocused();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeFocused();
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
});

test('card tag is keyboard accessible without selecting its persona', async ({ page }) => {
    await boot(page, settings({ persona_tag_map: { 'alice.png': ['fantasy'] } }));
    const chip = card(page, 'alice.png').getByRole('button', { name: 'Fantasy', exact: true });
    await chip.focus();
    await chip.press('Enter');
    await expect.poll(() => filtered(page)).toEqual(['alice.png']);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toBeFocused();
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
});

test('closing a dialog during a native refresh restores focus after its trigger disappears', async ({ page }) => {
    await boot(page, settings({ persona_tag_map: { 'alice.png': ['fantasy'], 'bob.png': ['fantasy'] } }));
    await chooseTag(page);
    await openTags(page);
    await page.evaluate(() => { PTFixture.deferRenders = true; });
    await dialog(page).getByRole('button', { name: 'Remove Fantasy from persona' }).click();
    await expect.poll(() => page.evaluate(() => PTFixture.pendingRenders.length)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(card(page, 'alice.png').getByRole('button', { name: 'Tags', exact: true })).toBeFocused();
    await page.evaluate(() => PTFixture.resolveRender());
    await expect(card(page, 'alice.png')).toHaveCount(0);
    await expect(page.locator('#persona-management-block')).toBeFocused();
});

test('delayed native refresh does not steal focus after a deliberate outside click', async ({ page }) => {
    await boot(page, settings({ persona_tag_map: { 'alice.png': ['fantasy'], 'bob.png': ['fantasy'] } }));
    await page.evaluate(() => { PTFixture.deferRenders = true; });
    await chooseTag(page);
    await expect.poll(() => page.evaluate(() => PTFixture.pendingRenders.length)).toBe(1);
    await page.locator('#outside-surface').click();
    await expect(page.locator('body')).toBeFocused();
    await page.evaluate(() => PTFixture.resolveRender());
    await expect.poll(() => filtered(page)).toEqual(['alice.png', 'bob.png']);
    await expect(page.locator('body')).toBeFocused();
});

test('duplicate folder creation leaves descriptions unchanged and successful retry clears feedback', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
    await page.locator('.pt-folder-card[data-folder="Work"]').click();
    await card(page, 'alice.png').getByRole('button', { name: 'Folders', exact: true }).click();
    await dialog(page).getByRole('textbox', { name: 'New folder name' }).fill('Work');
    await dialog(page).getByRole('textbox', { name: 'Folder description' }).fill('Changed');
    await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('#pt-new-folder-error')).toContainText('already exists');
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.folderDescriptions.Work)).toBe('Original');
    // The unchecked row stays available for undo until this dialog closes.
    await dialog(page).getByRole('checkbox', { name: 'Work', exact: true }).press('Space');
    await expect(dialog(page).getByRole('checkbox', { name: 'Work', exact: true })).not.toBeChecked();
    await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('#pt-new-folder-error')).toBeHidden();
    await expect(dialog(page).getByRole('textbox', { name: 'New folder name' })).not.toHaveAttribute('aria-invalid', 'true');
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.folderDescriptions.Work)).toBe('Changed');
});

test('folder editor persists description changes through a reload', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
    await page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-edit').click();
    await dialog(page).getByRole('textbox', { name: 'Folder description' }).fill('Updated description');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('personaToolsFixture') || '{}').PersonaTools?.folderDescriptions.Work)).toBe('Updated description');
    await page.reload();
    await waitForFixture(page);
    await expect(page.locator('.pt-folder-desc')).toHaveText('Updated description');
});

test('tag search preserves its caret when native decoration refreshes', async ({ page }) => {
    const tags = Array.from({ length: 8 }, (_, i) => ({ id: `tag${i}`, name: `Tag ${i}`, color: '#aaccee' }));
    await boot(page, settings({ persona_tags: tags }));
    await page.locator('.pt-tag-bar-toggle').click();
    const search = page.getByRole('searchbox', { name: 'Filter tags', exact: true });
    await search.fill('Tag');
    await search.evaluate(node => node.setSelectionRange(1, 2));
    await page.evaluate(() => PTFixture.render());
    await expect(search).toBeFocused();
    expect(await search.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([1, 2]);
});
