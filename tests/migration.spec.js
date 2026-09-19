import { test, expect, loadFixture, persistAndReload, waitForFixture } from './helpers.js';

const legacyTags = {
    persona_tags: [{ id: 'legacy-tag', name: 'Legacy', color: '#aaccee' }],
    persona_tag_map: { 'alice.png': ['legacy-tag'] },
};

function personaToolsSettings(overrides = {}) {
    return {
        personaGroups: {},
        persona_tags: [],
        persona_tag_map: {},
        folderDescriptions: {},
        ...overrides,
    };
}

async function settings(page) {
    return page.evaluate(() => window.PTFixture.extensionSettings.PersonaTools);
}

for (const source of ['current', 'historical']) {
    test(`migrates tag definitions and assignments from ${source} settings`, async ({ page }) => {
        await loadFixture(page, source === 'current'
            ? { extensionSettings: legacyTags }
            : { legacySettings: legacyTags });

        const migrated = await settings(page);
        expect(migrated.persona_tags).toEqual(legacyTags.persona_tags);
        expect(migrated.persona_tag_map).toEqual(legacyTags.persona_tag_map);
        expect(migrated._migratedTags).toBe(true);
        await expect(page.locator('[data-avatar-id="alice.png"] .pt-card-tags')).toHaveText('Legacy');
        expect(await page.evaluate(source => {
            const host = window.PTFixture;
            const original = source === 'current' ? host.extensionSettings : host.legacySettings;
            const migrated = host.extensionSettings.PersonaTools;
            return migrated.persona_tags !== original.persona_tags
                && migrated.persona_tag_map !== original.persona_tag_map;
        }, source)).toBe(true);

        await persistAndReload(page);
        expect((await settings(page)).persona_tag_map).toEqual(legacyTags.persona_tag_map);
        expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBe(0);
    });
}

test('prefers nonempty current settings without borrowing the historical assignment map', async ({ page }) => {
    const currentTags = [{ id: 'current-tag', name: 'Current', color: '#bbccdd' }];
    await loadFixture(page, {
        extensionSettings: { persona_tags: currentTags },
        legacySettings: legacyTags,
    });

    const migrated = await settings(page);
    expect(migrated.persona_tags).toEqual(currentTags);
    expect(migrated.persona_tag_map).toEqual({});
    expect(migrated._migratedTags).toBe(true);
    await expect(page.locator('.pt-card-tags')).toHaveCount(0);
});

test('a migrated tag deleted through the UI stays deleted after reload', async ({ page }) => {
    await loadFixture(page, { extensionSettings: legacyTags });
    await page.locator('[data-avatar-id="alice.png"] button[title="Tags"]').click();
    const deleteButton = page.getByRole('button', { name: 'Delete Legacy everywhere', exact: true });
    await deleteButton.click();
    const confirmDelete = page.getByRole('button', { name: 'Confirm delete Legacy everywhere', exact: true });
    await expect(confirmDelete).toHaveClass(/pt-armed/);
    await confirmDelete.click();
    await expect.poll(async () => (await settings(page)).persona_tags).toEqual([]);

    await persistAndReload(page);
    const reloaded = await settings(page);
    expect(reloaded.persona_tags).toEqual([]);
    expect(reloaded.persona_tag_map).toEqual({});
    expect(reloaded._migratedTags).toBe(true);
    expect(await page.evaluate(() => window.PTFixture.extensionSettings.persona_tags)).toEqual(legacyTags.persona_tags);
    expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBe(0);
    await expect(page.locator('.pt-card-tags')).toHaveCount(0);
});

for (const populated of ['definitions', 'assignments']) {
    test(`preserves both destination collections when ${populated} already exist`, async ({ page }) => {
        const existing = personaToolsSettings(populated === 'definitions'
            ? { persona_tags: [{ id: 'mine', name: 'My tag', color: '#ccddee' }] }
            : { persona_tag_map: { 'bob.png': ['mine'] } });
        await loadFixture(page, {
            extensionSettings: { ...legacyTags, PersonaTools: existing },
        });

        const migrated = await settings(page);
        expect(migrated.persona_tags).toEqual(existing.persona_tags);
        expect(migrated.persona_tag_map).toEqual(existing.persona_tag_map);
        expect(migrated._migratedTags).toBe(true);
        expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBeGreaterThan(0);

        await persistAndReload(page);
        const reloaded = await settings(page);
        expect(reloaded.persona_tags).toEqual(existing.persona_tags);
        expect(reloaded.persona_tag_map).toEqual(existing.persona_tag_map);
        expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBe(0);
    });
}

test('honors a prior tag marker and persists a PGM marker when existing folders block copying', async ({ page }) => {
    const existingGroups = { 'bob.png': ['Existing folder'] };
    await loadFixture(page, {
        extensionSettings: {
            ...legacyTags,
            personas: { personaGroups: { 'alice.png': ['Legacy folder'] } },
            PersonaTools: personaToolsSettings({ personaGroups: existingGroups, _migratedTags: true }),
        },
    });

    const migrated = await settings(page);
    expect(migrated.persona_tags).toEqual([]);
    expect(migrated.persona_tag_map).toEqual({});
    expect(migrated.personaGroups).toEqual(existingGroups);
    expect(migrated._migratedPGM).toBe(true);
    expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBeGreaterThan(0);

    await persistAndReload(page);
    expect((await settings(page))._migratedPGM).toBe(true);
    expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBe(0);
    await expect(page.locator('.pt-folder-card')).toHaveAttribute('data-folder', 'Existing folder');
});

test('persists the tag migration marker for a recognized empty legacy source', async ({ page }) => {
    await loadFixture(page, { extensionSettings: { persona_tags: [], persona_tag_map: {} } });
    const migrated = await settings(page);
    expect(migrated.persona_tags).toEqual([]);
    expect(migrated.persona_tag_map).toEqual({});
    expect(migrated._migratedTags).toBe(true);
    expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBeGreaterThan(0);

    await persistAndReload(page);
    expect((await settings(page))._migratedTags).toBe(true);
    expect(await page.evaluate(() => window.PTFixture.saveCalls)).toBe(0);
});

test('initialization persists migration and orphan pruning together without a forced save', async ({ page }) => {
    await loadFixture(page, {
        extensionSettings: {
            persona_tags: [],
            persona_tag_map: {},
            personas: { personaGroups: { 'alice.png': ['Work'] } },
            PersonaTools: personaToolsSettings({ folderDescriptions: { Work: 'Retained', Orphan: 'Removed' } }),
        },
    });

    const expected = await settings(page);
    expect(expected).toMatchObject({
        personaGroups: { 'alice.png': ['Work'] },
        folderDescriptions: { Work: 'Retained' },
        _migratedPGM: true,
        _migratedTags: true,
    });
    await expect.poll(() => page.evaluate(() => {
        const saved = localStorage.getItem('personaToolsFixture');
        return saved ? JSON.parse(saved).PersonaTools : null;
    })).toEqual(expected);

    await page.reload();
    await waitForFixture(page);
    expect(await settings(page)).toEqual(expected);
    await expect(page.locator('.pt-folder-desc')).toHaveText('Retained');
});
