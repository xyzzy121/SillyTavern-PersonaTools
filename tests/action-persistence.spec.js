import { test, expect, loadFixture, waitForFixture } from './helpers.js';

const savedSettings = page => page.evaluate(() => {
    const saved = localStorage.getItem('personaToolsFixture');
    return saved ? JSON.parse(saved).PersonaTools : null;
});

async function openAliceTags(page) {
    await page.locator('.avatar-container[data-avatar-id="alice.png"]').getByRole('button', { name: 'Tags', exact: true }).click();
    return page.getByRole('dialog');
}

test('tag creation and both assignment controls persist without a forced save', async ({ page }) => {
    await loadFixture(page);
    let dialog = await openAliceTags(page);
    await dialog.getByRole('textbox', { name: 'New tag name', exact: true }).fill('Planner');
    await dialog.getByLabel('Tag color', { exact: true }).fill('#00ee00');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    const tag = await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.persona_tags[0]);
    await expect.poll(() => savedSettings(page)).toMatchObject({
        persona_tags: [{ id: tag.id, name: 'Planner', color: '#00ee00' }],
        persona_tag_map: { 'alice.png': [tag.id] },
    });

    await page.reload();
    await waitForFixture(page);
    dialog = await openAliceTags(page);
    await dialog.getByRole('button', { name: 'Remove Planner from persona', exact: true }).click();
    await expect.poll(async () => (await savedSettings(page)).persona_tag_map).toEqual({});

    await dialog.getByRole('button', { name: 'Planner', exact: true }).click();
    await expect.poll(async () => (await savedSettings(page)).persona_tag_map).toEqual({ 'alice.png': [tag.id] });
    await page.reload();
    await waitForFixture(page);
    dialog = await openAliceTags(page);
    await expect(dialog.getByRole('button', { name: 'Remove Planner from persona', exact: true })).toBeVisible();
});

test('global tag deletion persists removed assignments while preserving other tags', async ({ page }) => {
    const shared = { id: 'shared', name: 'Shared', color: '#aaccee' };
    const keep = { id: 'keep', name: 'Keep', color: '#ffdbaa' };
    await loadFixture(page, { extensionSettings: { PersonaTools: {
        persona_tags: [shared, keep],
        persona_tag_map: { 'alice.png': ['shared'], 'bob.png': ['shared', 'keep'] },
    } } });
    await page.locator('.pt-tag-bar-toggle').click();
    await page.locator('.pt-tag-bar-chips').getByRole('button', { name: /^Shared/ }).click();
    const dialog = await openAliceTags(page);
    await dialog.getByRole('button', { name: 'Delete Shared everywhere', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm delete Shared everywhere', exact: true }).click();
    await expect.poll(() => savedSettings(page)).toMatchObject({
        persona_tags: [keep], persona_tag_map: { 'bob.png': ['keep'] },
    });

    await page.reload();
    await waitForFixture(page);
    await expect(page.locator('.avatar-container[data-avatar-id="bob.png"] .pt-card-tags')).toHaveText('Keep');
    await expect(page.locator('.avatar-container[data-avatar-id="alice.png"] .pt-card-tags')).toHaveCount(0);
});

test('duplicate inheritance and persona deletion persist without a forced save', async ({ page }) => {
    const originalGroups = { 'alice.png': ['Work'] };
    const originalTags = { 'alice.png': ['hero'] };
    await loadFixture(page, { extensionSettings: { PersonaTools: {
        personaGroups: originalGroups,
        folderDescriptions: { Work: 'Original description' },
        persona_tags: [{ id: 'hero', name: 'Hero', color: '#aaccee' }],
        persona_tag_map: originalTags,
    } } });
    await page.evaluate(() => PTFixture.duplicate('alice.png', 'copy.png'));
    await expect.poll(() => savedSettings(page)).toMatchObject({
        personaGroups: { ...originalGroups, 'copy.png': ['Work'] },
        persona_tag_map: { ...originalTags, 'copy.png': ['hero'] },
        folderDescriptions: { Work: 'Original description' },
    });
    await page.evaluate(() => PTFixture.delete('copy.png'));
    await expect.poll(async () => {
        const saved = await savedSettings(page);
        return { groups: saved.personaGroups, tags: saved.persona_tag_map };
    }).toEqual({ groups: originalGroups, tags: originalTags });

    await page.reload();
    await waitForFixture(page);
    expect(await page.evaluate(() => PTFixture.extensionSettings.PersonaTools.folderDescriptions)).toEqual({ Work: 'Original description' });
    await expect(page.locator('.pt-folder-card[data-folder="Work"] .pt-folder-count')).toHaveText('1');
});
