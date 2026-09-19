import { test, expect, loadFixture, waitForFixture } from './helpers.js';

const hero = { id: 'hero', name: 'Hero', color: '#aaccee' };
const settings = (overrides = {}) => ({
    personaGroups: {}, folderDescriptions: {}, persona_tags: [hero], persona_tag_map: {}, ...overrides,
});
const card = (page, id) => page.locator(`.avatar-container[data-avatar-id="${id}"]`);
const dialog = page => page.getByRole('dialog');
const readSettings = page => page.evaluate(() => PTFixture.extensionSettings.PersonaTools);

async function expectAutosaved(page) {
    const expected = await readSettings(page);
    await expect.poll(() => page.evaluate(() => {
        const saved = localStorage.getItem('personaToolsFixture');
        return saved ? JSON.parse(saved).PersonaTools : null;
    })).toEqual(expected);
    return expected;
}

async function reloadAutosaved(page) {
    const expected = await expectAutosaved(page);
    await page.reload();
    await waitForFixture(page);
    expect(await readSettings(page)).toEqual(expected);
}

async function boot(page, data) {
    await loadFixture(page, { extensionSettings: { PersonaTools: data } });
}

async function openAliceFolders(page) {
    await page.locator('.pt-folder-card[data-folder="Work"]').click();
    await card(page, 'alice.png').getByRole('button', { name: 'Folders', exact: true }).click();
}

async function createFolder(page, name, description = '') {
    await dialog(page).getByRole('textbox', { name: 'New folder name', exact: true }).fill(name);
    await dialog(page).getByRole('textbox', { name: 'Folder description', exact: true }).fill(description);
    await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
}

test('last folder membership can be undone in its dialog without losing its description', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
    await openAliceFolders(page);
    const checkbox = dialog(page).getByRole('checkbox', { name: 'Work', exact: true });
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeFocused();
    expect((await readSettings(page)).folderDescriptions).toEqual({});
    await expectAutosaved(page);
    await checkbox.check();
    expect((await readSettings(page)).folderDescriptions).toEqual({ Work: 'Original' });
    await reloadAutosaved(page);
    await expect(page.locator('.pt-folder-desc')).toHaveText('Original');
});

test('closing a folder dialog discards its undo before a fresh folder is created', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
    await openAliceFolders(page);
    await dialog(page).getByRole('checkbox', { name: 'Work', exact: true }).uncheck();
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    if (await page.locator('.pt-folder-header').isVisible()) await page.getByRole('button', { name: 'Back to all personas' }).click();
    await card(page, 'bob.png').getByRole('button', { name: 'Folders', exact: true }).click();
    await expect(dialog(page).getByRole('checkbox', { name: 'Work', exact: true })).toHaveCount(0);
    await createFolder(page, 'Work');
    expect((await readSettings(page)).folderDescriptions).toEqual({});
    await reloadAutosaved(page);
    await expect(page.locator('.pt-folder-card[data-folder="Work"]')).toHaveCount(1);
    await expect(page.locator('.pt-folder-desc')).toHaveCount(0);
});

test('explicit Create uses a blank description instead of the current dialog undo', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
    await openAliceFolders(page);
    await dialog(page).getByRole('checkbox', { name: 'Work', exact: true }).uncheck();
    await createFolder(page, 'Work');
    const checkbox = dialog(page).getByRole('checkbox', { name: 'Work', exact: true });
    await expect(checkbox).toBeChecked();
    await expectAutosaved(page);
    await checkbox.uncheck();
    await expectAutosaved(page);
    await checkbox.check();
    expect((await readSettings(page)).folderDescriptions).toEqual({});
    await reloadAutosaved(page);
    await expect(page.locator('.pt-folder-desc')).toHaveCount(0);
});

for (const fromFolder of [false, true]) {
    test(`removing the last member closes the ${fromFolder ? 'folder' : 'root'} editor and discards obsolete drafts`, async ({ page }) => {
        await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
        if (fromFolder) {
            await page.locator('.pt-folder-card[data-folder="Work"]').click();
            await page.locator('.pt-folder-header').getByRole('button', { name: 'Edit folder', exact: true }).click();
        } else await page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-edit').click();
        await dialog(page).getByRole('textbox', { name: 'Folder name', exact: true }).fill('Renamed');
        await dialog(page).getByRole('textbox', { name: 'Folder description', exact: true }).fill('New description');
        const oldSave = await dialog(page).getByRole('button', { name: 'Save', exact: true }).elementHandle();
        await dialog(page).getByRole('button', { name: 'Remove Alice from folder', exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        await oldSave.evaluate(node => node.click());
        expect((await readSettings(page)).personaGroups).toEqual({});
        expect((await readSettings(page)).folderDescriptions).toEqual({});
        await reloadAutosaved(page);
        await expect(page.locator('.pt-folder-card')).toHaveCount(0);
        expect((await readSettings(page)).folderDescriptions).toEqual({});
    });
}

for (const name of ['toString', 'constructor']) {
    test(`folder ${name} has only its own description through creation, editing and reload`, async ({ page }) => {
        await boot(page, settings());
        await card(page, 'alice.png').getByRole('button', { name: 'Folders', exact: true }).click();
        await createFolder(page, name);
        await expectAutosaved(page);
        await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
        const folder = page.locator(`.pt-folder-card[data-folder="${name}"]`);
        await expect(folder).toHaveCount(1);
        await expect(folder.locator('.pt-folder-desc')).toHaveCount(0);
        await folder.locator('.pt-folder-edit').click();
        await expect(dialog(page).getByRole('textbox', { name: 'Folder description', exact: true })).toHaveValue('');
        await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
        expect((await readSettings(page)).folderDescriptions).toEqual({});
        await folder.locator('.pt-folder-edit').click();
        await dialog(page).getByRole('textbox', { name: 'Folder description', exact: true }).fill('My description');
        await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
        await reloadAutosaved(page);
        await expect(folder.locator('.pt-folder-desc')).toHaveText('My description');
        await folder.locator('.pt-folder-edit').click();
        await dialog(page).getByRole('textbox', { name: 'Folder name', exact: true }).fill('Renamed');
        await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
        expect((await readSettings(page)).folderDescriptions).toEqual({ Renamed: 'My description' });
        await reloadAutosaved(page);
    });
}

for (const targetDescription of ['', 'Destination']) {
    test(`merging into a built-in property name preserves ${targetDescription ? 'destination' : 'source'} description and shared memberships`, async ({ page }) => {
        await boot(page, settings({
            personaGroups: { 'alice.png': ['Work', 'constructor'], 'bob.png': ['Work'], 'cara.png': ['constructor'] },
            folderDescriptions: targetDescription ? { Work: 'Source', constructor: targetDescription } : { Work: 'Source' },
            persona_tag_map: { 'alice.png': ['hero'] },
        }));
        await page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-edit').click();
        await dialog(page).getByRole('textbox', { name: 'Folder name', exact: true }).fill('constructor');
        await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
        const data = await readSettings(page);
        expect(data.personaGroups).toEqual({ 'alice.png': ['constructor'], 'bob.png': ['constructor'], 'cara.png': ['constructor'] });
        expect(data.folderDescriptions).toEqual({ constructor: targetDescription || 'Source' });
        expect(data.persona_tag_map).toEqual({ 'alice.png': ['hero'] });
        await reloadAutosaved(page);
        await expect(page.locator('.pt-folder-desc')).toHaveText(targetDescription || 'Source');
    });
}

for (const kind of ['Folders', 'Tags']) {
    test(`native persona deletion closes its ${kind} dialog and makes queued controls harmless`, async ({ page }) => {
        await boot(page, settings({ personaGroups: { 'bob.png': ['Home'] } }));
        await card(page, 'alice.png').getByRole('button', { name: kind, exact: true }).click();
        const oldControl = await (kind === 'Folders'
            ? dialog(page).getByRole('checkbox', { name: 'Home', exact: true })
            : dialog(page).getByRole('button', { name: 'Hero', exact: true })).elementHandle();
        await page.evaluate(() => PTFixture.delete('alice.png'));
        await expect(dialog(page)).toHaveCount(0);
        await oldControl.evaluate(node => node.click());
        const data = await readSettings(page);
        expect(data.personaGroups).toEqual({ 'bob.png': ['Home'] });
        expect(data.persona_tag_map).toEqual({});
    });
}

test('native deletion refreshes a folder editor without erasing its unsaved draft', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'], 'bob.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
    await page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-edit').click();
    await dialog(page).getByRole('textbox', { name: 'Folder name', exact: true }).fill('Renamed');
    await dialog(page).getByRole('textbox', { name: 'Folder description', exact: true }).fill('Draft');
    await page.evaluate(() => PTFixture.delete('alice.png'));
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Remove Alice from folder', exact: true })).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Remove Bob from folder', exact: true })).toHaveCount(1);
    await expect(dialog(page).getByRole('textbox', { name: 'Folder name', exact: true })).toHaveValue('Renamed');
    await expect(dialog(page).getByRole('textbox', { name: 'Folder description', exact: true })).toHaveValue('Draft');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    expect((await readSettings(page)).folderDescriptions).toEqual({ Renamed: 'Draft' });
    expect((await readSettings(page)).personaGroups).toEqual({ 'bob.png': ['Renamed'] });
    await reloadAutosaved(page);
});

test('native deletion of the last member closes the folder editor without leaving an orphan description', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] }, folderDescriptions: { Work: 'Original' } }));
    await page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-edit').click();
    await dialog(page).getByRole('textbox', { name: 'Folder description', exact: true }).fill('Draft');
    await page.evaluate(() => PTFixture.delete('alice.png'));
    await expect(dialog(page)).toHaveCount(0);
    expect((await readSettings(page)).personaGroups).toEqual({});
    expect((await readSettings(page)).folderDescriptions).toEqual({});
});

test('saving an editor after external membership removal refreshes the root folder cards', async ({ page }) => {
    await boot(page, settings({ personaGroups: { 'alice.png': ['Work'] } }));
    await page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-edit').click();
    await dialog(page).getByRole('textbox', { name: 'Folder name', exact: true }).fill('Obsolete draft');
    // A host settings update can replace memberships without a persona-deleted event.
    await page.evaluate(() => { PTFixture.extensionSettings.PersonaTools.personaGroups = {}; });
    await expect(page.locator('.pt-folder-card[data-folder="Work"]')).toHaveCount(1);
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.pt-folder-card')).toHaveCount(0);
    await expect(card(page, 'alice.png')).toBeVisible();
    expect((await readSettings(page)).personaGroups).toEqual({});
});

test('folder creation, rename with description editing, and deletion persist as complete actions', async ({ page }) => {
    await boot(page, settings({
        personaGroups: { 'bob.png': ['Keep'] },
        folderDescriptions: { Keep: 'Preserved' },
        persona_tag_map: { 'alice.png': ['hero'] },
    }));
    await card(page, 'alice.png').getByRole('button', { name: 'Folders', exact: true }).click();
    await createFolder(page, 'Work', 'Created description');
    await reloadAutosaved(page);
    await expect(page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-desc')).toHaveText('Created description');

    await page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-edit').click();
    await dialog(page).getByRole('textbox', { name: 'Folder name', exact: true }).fill('Renamed');
    await dialog(page).getByRole('textbox', { name: 'Folder description', exact: true }).fill('Edited description');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    expect((await readSettings(page)).personaGroups).toEqual({ 'alice.png': ['Renamed'], 'bob.png': ['Keep'] });
    expect((await readSettings(page)).folderDescriptions).toEqual({ Keep: 'Preserved', Renamed: 'Edited description' });
    await reloadAutosaved(page);

    await page.locator('.pt-folder-card[data-folder="Renamed"] .pt-folder-edit').click();
    await dialog(page).getByRole('button', { name: 'Delete folder', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Really delete?', exact: true }).click();
    expect((await readSettings(page)).personaGroups).toEqual({ 'bob.png': ['Keep'] });
    expect((await readSettings(page)).folderDescriptions).toEqual({ Keep: 'Preserved' });
    expect((await readSettings(page)).persona_tag_map).toEqual({ 'alice.png': ['hero'] });
    await reloadAutosaved(page);
    await expect(page.locator('.pt-folder-card')).toHaveAttribute('data-folder', 'Keep');
    await expect(card(page, 'alice.png')).toBeVisible();
});
