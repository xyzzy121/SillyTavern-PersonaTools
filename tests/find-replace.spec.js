import { test, expect, loadFixture, nextPaint, waitForFixture } from './helpers.js';

const fields = ['Name', 'Title', 'Description'];
const nativeData = page => page.evaluate(() => structuredClone(PTFixture.powerUser));

async function openReplace(page) {
    await page.getByRole('button', { name: 'Find and replace', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Find and replace', exact: true });
    await expect(dialog).toBeVisible();
    await nextPaint(page);
    return dialog;
}

async function chooseFields(dialog, selected) {
    for (const field of fields) await dialog.getByRole('checkbox', { name: field, exact: true }).setChecked(selected.includes(field));
}

function persona(dialog, name, id) {
    return dialog.getByRole('checkbox', { name: `Select ${name} (${id})`, exact: true });
}

async function prepareDescription(page, { source = 'old old', find = 'old', replacement = 'new', regex = false, matchCase = true } = {}) {
    await loadFixture(page, { personas: { 'alice.png': 'Alice' }, descriptions: { 'alice.png': { description: source, title: 'Unchanged' } } });
    const dialog = await openReplace(page);
    await persona(dialog, 'Alice', 'alice.png').check();
    await chooseFields(dialog, ['Description']);
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill(find);
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill(replacement);
    await dialog.getByRole('checkbox', { name: 'Use regular expression', exact: true }).setChecked(regex);
    await dialog.getByRole('checkbox', { name: 'Match case', exact: true }).setChecked(matchCase);
    return dialog;
}

async function preview(dialog) {
    await dialog.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeEnabled();
}

async function apply(dialog) {
    await dialog.getByRole('button', { name: 'Apply replacements', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();
    await expect.poll(async () => /Applied replacements/.test(await dialog.locator('.pt-replace-status').textContent())
        || await dialog.locator('.pt-replace-error').isVisible()).toBe(true);
}

test('the checklist includes filtered and paginated personas, searches title and ID, and preserves hidden selections', async ({ page }) => {
    const personas = { 'alice.png': 'Alice', 'alice-copy.png': 'Alice', 'bob.png': 'Bob', 'cara.png': 'Cara', 'dora.png': 'Dora', 'erin.png': 'Erin', 'faye.png': 'Faye' };
    await loadFixture(page, {
        personas,
        descriptions: { 'bob.png': { title: 'Royal mage', description: '' } },
        extensionSettings: { PersonaTools: { personaGroups: { 'alice.png': ['Work'] } } },
    });
    await page.locator('.pt-folder-card[data-folder="Work"]').click();
    await page.locator('#persona_search_bar').fill('Alice');
    const dialog = await openReplace(page);
    const checkboxes = dialog.getByRole('checkbox', { name: /^Select / });
    await expect(checkboxes).toHaveCount(Object.keys(personas).length);
    expect(await checkboxes.evaluateAll(nodes => nodes.every(node => !node.checked))).toBe(true);
    for (const field of fields) await expect(dialog.getByRole('checkbox', { name: field, exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Match case', exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Use regular expression', exact: true })).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();

    await persona(dialog, 'Alice', 'alice.png').check();
    const search = dialog.getByRole('searchbox', { name: 'Search personas', exact: true });
    await search.fill('Royal mage');
    await expect(checkboxes).toHaveCount(1);
    await persona(dialog, 'Bob', 'bob.png').check();
    await search.fill('alice-copy.png');
    await dialog.getByRole('button', { name: 'Select all results', exact: true }).click();
    await search.fill('');
    for (const [name, id] of [['Alice', 'alice.png'], ['Alice', 'alice-copy.png'], ['Bob', 'bob.png']]) await expect(persona(dialog, name, id)).toBeChecked();
    await expect(persona(dialog, 'Cara', 'cara.png')).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click();
    expect(await checkboxes.evaluateAll(nodes => nodes.every(node => !node.checked))).toBe(true);
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pt-folder-header')).toContainText('Work');
    await expect(page.locator('#persona_search_bar')).toHaveValue('Alice');
});

for (const scenario of [
    { label: 'repeated non-overlapping matches', source: 'aaaa', find: 'aa', replacement: 'b', expected: 'bb' },
    { label: 'regex punctuation and dollar tokens literally', source: '[old]. [old].', find: '[old].', replacement: '$1-$&-$$', expected: '$1-$&-$$ $1-$&-$$' },
    { label: 'case-sensitive Unicode text', source: 'Écho écho Écho', find: 'Écho', replacement: '雪', expected: '雪 écho 雪' },
    { label: 'case-insensitive Unicode text', source: 'Écho écho ÉCHO', find: 'éCHO', replacement: '雪', expected: '雪 雪 雪', matchCase: false },
    { label: 'multiline text and surrounding whitespace', source: '  old\n old\n tail  ', find: ' old\n', replacement: '\nnew ', expected: ' \nnew \nnew  tail  ' },
    { label: 'an empty replacement', source: 'old old old', find: 'old', replacement: '', expected: '  ' },
]) {
    test(`literal replacement handles ${scenario.label}`, async ({ page }) => {
        const dialog = await prepareDescription(page, scenario);
        const before = await nativeData(page);
        await preview(dialog);
        expect(await nativeData(page)).toEqual(before);
        await expect(dialog.locator('.pt-replace-preview')).toContainText(scenario.expected.trim());
        await apply(dialog);
        expect((await nativeData(page)).persona_descriptions['alice.png']).toEqual({ title: 'Unchanged', description: scenario.expected });
    });
}

for (const scenario of [
    { label: 'numbered groups and standard replacement tokens', source: 'old-12 old-34', find: '(old)-(\\d+)', replacement: '$2:$1:$&:$$', expected: '12:old:old-12:$ 34:old:old-34:$' },
    { label: 'named groups with case-insensitive matching', source: 'RED blue', find: '(?<color>red|blue)', replacement: '$<color>!', expected: 'RED! blue!', matchCase: false },
    { label: 'zero-length matches', source: 'aba', find: '(?=a)', replacement: '_', expected: '_ab_a' },
]) {
    test(`regex replacement handles ${scenario.label}`, async ({ page }) => {
        const dialog = await prepareDescription(page, { ...scenario, regex: true });
        await preview(dialog);
        await apply(dialog);
        expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe(scenario.expected);
    });
}

test('invalid regex and no-op replacements leave native data unchanged', async ({ page }) => {
    const dialog = await prepareDescription(page, { find: '[', regex: true });
    const before = await nativeData(page);
    const previewButton = dialog.getByRole('button', { name: 'Preview changes', exact: true });
    const applyButton = dialog.getByRole('button', { name: 'Apply replacements', exact: true });
    await previewButton.click();
    await expect(dialog.locator('.pt-replace-error')).toContainText(/regular expression|regex|pattern/i);
    await expect(applyButton).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'Use regular expression', exact: true }).uncheck();
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('old');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('old');
    await previewButton.click();
    await expect(dialog.locator('.pt-replace-status')).toContainText(/0 personas and 0 fields/i);
    await expect(applyButton).toBeDisabled();
    expect(await nativeData(page)).toEqual(before);
});

test('preview requires a persona, a text field, and nonempty Find text', async ({ page }) => {
    await loadFixture(page);
    const dialog = await openReplace(page);
    const previewButton = dialog.getByRole('button', { name: 'Preview changes', exact: true });
    const applyButton = dialog.getByRole('button', { name: 'Apply replacements', exact: true });
    await previewButton.click();
    await expect(dialog.locator('.pt-replace-error')).toContainText(/persona/i);
    await persona(dialog, 'Alice', 'alice.png').check();
    await chooseFields(dialog, []);
    await previewButton.click();
    await expect(dialog.locator('.pt-replace-error')).toContainText(/field/i);
    await chooseFields(dialog, ['Description']);
    await previewButton.click();
    await expect(dialog.locator('.pt-replace-error')).toContainText(/find/i);
    await expect(applyButton).toBeDisabled();
});

test('timed-out matching remains responsive and recovers on the next preview', async ({ page }) => {
    await page.route('**/find-replace-worker.js', route => route.fulfill({ contentType: 'text/javascript', body: 'self.onmessage = () => {};' }));
    const dialog = await prepareDescription(page);
    const before = await nativeData(page);
    await dialog.getByRole('button', { name: 'Preview changes', exact: true }).click();
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
    await expect(dialog.locator('.pt-replace-error')).toContainText(/timed out|too long|timeout|longer than two/i);
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();
    expect(await nativeData(page)).toEqual(before);
    await page.unroute('**/find-replace-worker.js');
    await preview(dialog);
    await apply(dialog);
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe('new new');
});

test('editing or closing during matching disposes the worker and ignores an obsolete reply', async ({ page }) => {
    await page.addInitScript(() => {
        window.replacementWorkers = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) { super(...args); this.terminationCount = 0; window.replacementWorkers.push(this); }
            terminate() { this.terminationCount++; super.terminate(); }
        };
    });
    await page.route('**/find-replace-worker.js', route => route.fulfill({ contentType: 'text/javascript', body: 'self.onmessage = () => {};' }));
    const dialog = await prepareDescription(page);
    await dialog.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Preview changes', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('fresh');
    expect(await page.evaluate(() => replacementWorkers[0].terminationCount)).toBe(1);
    await page.evaluate(() => replacementWorkers[0].onmessage({ data: { error: 'Obsolete response' } }));
    await expect(dialog.locator('.pt-replace-error')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => replacementWorkers[1].terminationCount)).toBe(1);
    await page.unroute('**/find-replace-worker.js');
    const reopened = await openReplace(page);
    await expect(reopened.getByRole('textbox', { name: 'Find', exact: true })).toHaveValue('');
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe('old old');
});

test('each replacement setting and selection invalidates the prepared preview', async ({ page }) => {
    const dialog = await prepareDescription(page);
    const applyButton = dialog.getByRole('button', { name: 'Apply replacements', exact: true });
    for (const change of [
        () => dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('fresh'),
        () => dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('ol'),
        () => dialog.getByRole('checkbox', { name: 'Match case', exact: true }).uncheck(),
        () => dialog.getByRole('checkbox', { name: 'Use regular expression', exact: true }).check(),
        () => dialog.getByRole('checkbox', { name: 'Title', exact: true }).check(),
    ]) {
        await preview(dialog);
        await change();
        await expect(applyButton).toBeDisabled();
    }
    await preview(dialog);
    await persona(dialog, 'Alice', 'alice.png').uncheck();
    await expect(applyButton).toBeDisabled();
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe('old old');
});

for (const modification of ['edit', 'delete']) {
    test(`a persona ${modification} after preview blocks the entire batch`, async ({ page }) => {
        await loadFixture(page, { personas: { 'alice.png': 'Old Alice', 'bob.png': 'Old Bob' } });
        const dialog = await openReplace(page);
        await dialog.getByRole('button', { name: 'Select all results', exact: true }).click();
        await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Old');
        await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('New');
        await preview(dialog);
        await page.evaluate(modification => {
            if (modification === 'edit') PTFixture.powerUser.personas['bob.png'] = 'Externally edited Bob';
            else {
                delete PTFixture.powerUser.personas['bob.png'];
                PTFixture.avatars = PTFixture.avatars.filter(id => id !== 'bob.png');
            }
        }, modification);
        const beforeApply = await nativeData(page);
        await apply(dialog);
        await expect(dialog.locator('.pt-replace-error')).toContainText(/changed|no longer|removed|deleted|preview/i);
        expect(await nativeData(page)).toEqual(beforeApply);
    });
}

test('an unchanged selected field changing after preview still blocks application', async ({ page }) => {
    const dialog = await prepareDescription(page);
    await dialog.getByRole('checkbox', { name: 'Title', exact: true }).check();
    await preview(dialog);
    await page.evaluate(() => { PTFixture.powerUser.persona_descriptions['alice.png'].title = 'External title'; });
    await apply(dialog);
    await expect(dialog.locator('.pt-replace-error')).toBeVisible();
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe('old old');
});

test('a native deletion updates the checklist and invalidates the preview', async ({ page }) => {
    await loadFixture(page, { personas: { 'alice.png': 'Old Alice', 'bob.png': 'Old Bob' } });
    const dialog = await openReplace(page);
    await dialog.getByRole('button', { name: 'Select all results', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Old');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('New');
    await preview(dialog);
    await page.evaluate(() => PTFixture.delete('bob.png'));
    await expect(persona(dialog, 'Old Bob', 'bob.png')).toHaveCount(0);
    await expect(dialog.locator('.pt-replace-count')).toHaveText('1 selected');
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();
    await expect(dialog.locator('.pt-replace-error')).toContainText(/changed/i);
    expect((await nativeData(page)).personas['alice.png']).toBe('Old Alice');
});

test('blank resulting names block the batch but empty titles and descriptions are allowed', async ({ page }) => {
    await loadFixture(page, { personas: { 'alice.png': 'old' }, descriptions: { 'alice.png': { title: 'old', description: 'old' } } });
    const dialog = await openReplace(page);
    await persona(dialog, 'old', 'alice.png').check();
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('old');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('  ');
    await dialog.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await expect(dialog.locator('.pt-replace-error')).toContainText(/name|blank|empty/i);
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();
    expect((await nativeData(page)).personas['alice.png']).toBe('old');
    await dialog.getByRole('checkbox', { name: 'Name', exact: true }).uncheck();
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('');
    await preview(dialog);
    await apply(dialog);
    expect((await nativeData(page)).persona_descriptions['alice.png']).toMatchObject({ title: '', description: '' });
});

test('missing descriptors are initialized only for a changed text field', async ({ page }) => {
    await loadFixture(page, { personas: { 'alice.png': 'Old Alice', 'bob.png': 'Old Bob' } });
    let dialog = await openReplace(page);
    await dialog.getByRole('button', { name: 'Select all results', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Old');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('New');
    await preview(dialog);
    await apply(dialog);
    expect((await nativeData(page)).persona_descriptions).toEqual({});
    await page.keyboard.press('Escape');
    dialog = await openReplace(page);
    await persona(dialog, 'New Bob', 'bob.png').check();
    await chooseFields(dialog, ['Title']);
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('^');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('New title');
    await dialog.getByRole('checkbox', { name: 'Use regular expression', exact: true }).check();
    await preview(dialog);
    await apply(dialog);
    const data = await nativeData(page);
    expect(data.persona_descriptions['bob.png'].title).toBe('New title');
    expect(data.persona_descriptions['alice.png']).toBeUndefined();
});

test('preview renders text safely, and dismissal discards the draft and restores focus', async ({ page }) => {
    const source = '<img src=x onerror="window.ptUnsafe=true">\nold';
    const dialog = await prepareDescription(page, { source, replacement: '<script>window.ptUnsafe=true</script>' });
    await preview(dialog);
    await expect(dialog.locator('.pt-replace-preview')).toContainText(source);
    await expect(dialog.locator('.pt-replace-preview img, .pt-replace-preview script')).toHaveCount(0);
    expect(await page.evaluate(() => window.ptUnsafe)).toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const button = page.getByRole('button', { name: 'Find and replace', exact: true });
    await expect(button).toBeFocused();
    const reopened = await openReplace(page);
    await expect(reopened.getByRole('textbox', { name: 'Find', exact: true })).toHaveValue('');
    await expect(reopened.getByRole('textbox', { name: 'Replace with', exact: true })).toHaveValue('');
    await expect(persona(reopened, 'Alice', 'alice.png')).not.toBeChecked();
    await expect(reopened.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe(source);
});

test('a refresh failure can be retried without performing the replacement again', async ({ page }) => {
    const dialog = await prepareDescription(page, { replacement: 'oldold' });
    await preview(dialog);
    await page.evaluate(() => { PTFixture.renderFailure = 'reject'; });
    await apply(dialog);
    await expect(page.locator('#pt-list-error')).toBeVisible();
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe('oldold oldold');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { PTFixture.renderFailure = null; });
    await page.locator('#pt-list-error').getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('#pt-list-error')).toBeHidden();
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe('oldold oldold');
});

test('batch application persists native fields, synchronizes the active persona, and preserves metadata and the current view', async ({ page }) => {
    const descriptions = {
        'alice.png': { title: 'Old title', description: 'Old story', lorebook: 'Old lorebook', position: 2, depth: 4, role: 1, custom: { value: 'Old metadata' } },
        'bob.png': { title: 'Old title', description: 'Old story', lorebook: 'Another book' },
        'cara.png': { title: 'Old title', description: 'Old story' },
    };
    await loadFixture(page, {
        personas: { 'alice.png': 'Old Alice', 'bob.png': 'Old Bob', 'cara.png': 'Old Cara' }, descriptions,
        extensionSettings: { PersonaTools: {
            personaGroups: { 'alice.png': ['Old folder'] }, folderDescriptions: { 'Old folder': 'Old folder description' },
            persona_tags: [{ id: 'old', name: 'Old tag', color: '#aaccee' }], persona_tag_map: { 'alice.png': ['old'] },
        } },
    });
    await page.locator('.pt-folder-card[data-folder="Old folder"]').click();
    await page.locator('#persona_search_bar').fill('Alice');
    await page.locator('#chat-input').fill('Old existing chat draft');
    await page.evaluate(() => {
        PTFixture.powerUser.default_persona = 'alice.png';
        PTFixture.powerUser.persona_chat_lock = 'alice.png';
    });
    const before = await page.evaluate(() => ({ settings: structuredClone(PTFixture.extensionSettings), refreshCalls: PTFixture.refreshCalls }));
    const dialog = await openReplace(page);
    await persona(dialog, 'Old Alice', 'alice.png').check();
    await persona(dialog, 'Old Bob', 'bob.png').check();
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Old');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('New');
    await preview(dialog);
    await expect(dialog.locator('.pt-replace-status')).toContainText('6 matches; 2 personas and 6 fields');
    await apply(dialog);
    const state = await page.evaluate(() => ({
        powerUser: PTFixture.powerUser, settings: PTFixture.extensionSettings, currentAvatar: PTFixture.currentAvatar,
        selectionCalls: PTFixture.selectionCalls, setUserNameCalls: PTFixture.setUserNameCalls,
        descriptionRefreshCalls: PTFixture.descriptionRefreshCalls, events: PTFixture.emittedEvents, refreshCalls: PTFixture.refreshCalls,
    }));
    expect(state.powerUser.personas).toEqual({ 'alice.png': 'New Alice', 'bob.png': 'New Bob', 'cara.png': 'Old Cara' });
    expect(state.powerUser.persona_descriptions).toEqual({
        'alice.png': { ...descriptions['alice.png'], title: 'New title', description: 'New story' },
        'bob.png': { ...descriptions['bob.png'], title: 'New title', description: 'New story' },
        'cara.png': descriptions['cara.png'],
    });
    expect(state.powerUser.persona_description).toBe('New story');
    expect(state.powerUser.default_persona).toBe('alice.png');
    expect(state.powerUser.persona_chat_lock).toBe('alice.png');
    expect(state.settings).toEqual(before.settings);
    expect(state.currentAvatar).toBe('alice.png');
    expect(state.selectionCalls).toEqual([]);
    expect(state.setUserNameCalls).toEqual([{ value: 'New Alice', toastPersonaNameChange: false }]);
    expect(state.descriptionRefreshCalls).toBe(1);
    expect(state.events).toEqual([
        { type: 'PERSONA_RENAMED', payload: { avatarId: 'alice.png', oldName: 'Old Alice', newName: 'New Alice' } },
        { type: 'PERSONA_UPDATED', payload: 'alice.png' },
        { type: 'PERSONA_RENAMED', payload: { avatarId: 'bob.png', oldName: 'Old Bob', newName: 'New Bob' } },
        { type: 'PERSONA_UPDATED', payload: 'bob.png' },
    ]);
    expect(state.refreshCalls).toBe(before.refreshCalls + 1);
    await expect(page.locator('#your_name')).toHaveValue('New Alice');
    await expect(page.locator('#persona_description')).toHaveValue('New story');
    await expect(page.locator('#chat-input')).toHaveValue('Old existing chat draft');
    await page.keyboard.press('Escape');
    await expect(page.locator('.pt-folder-header')).toContainText('Old folder');
    await expect(page.locator('#persona_search_bar')).toHaveValue('Alice');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('personaToolsFixtureNative') || 'null')?.personas['alice.png'])).toBe('New Alice');
    await page.reload();
    await waitForFixture(page);
    expect((await nativeData(page)).persona_descriptions).toEqual(state.powerUser.persona_descriptions);
    await expect(page.locator('#your_name')).toHaveValue('New Alice');
    await expect(page.locator('#persona_description')).toHaveValue('New story');
});

test('an excluded field and an unselected persona remain untouched', async ({ page }) => {
    await loadFixture(page, {
        personas: { 'alice.png': 'Old Alice', 'bob.png': 'Old Bob' },
        descriptions: { 'alice.png': { title: 'Old title', description: 'Old story' }, 'bob.png': { title: 'Old title', description: 'Old story' } },
    });
    const dialog = await openReplace(page);
    await persona(dialog, 'Old Alice', 'alice.png').check();
    await chooseFields(dialog, ['Title']);
    await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Old');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('New');
    await preview(dialog);
    await apply(dialog);
    const state = await nativeData(page);
    expect(state.personas).toEqual({ 'alice.png': 'Old Alice', 'bob.png': 'Old Bob' });
    expect(state.persona_descriptions).toEqual({ 'alice.png': { title: 'New title', description: 'Old story' }, 'bob.png': { title: 'Old title', description: 'Old story' } });
    expect(await page.evaluate(() => PTFixture.setUserNameCalls)).toEqual([]);
});

test('duplicate Apply activation consumes the preview and emits one update', async ({ page }) => {
    const dialog = await prepareDescription(page, { replacement: 'oldold' });
    await preview(dialog);
    await page.evaluate(() => {
        const button = [...document.querySelectorAll('.pt-replace-dialog button')].find(node => node.textContent === 'Apply replacements');
        button.click();
        button.click();
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(dialog.locator('.pt-replace-status')).toContainText('Applied replacements');
    await expect(dialog.getByRole('button', { name: 'Apply replacements', exact: true })).toBeDisabled();
    expect((await nativeData(page)).persona_descriptions['alice.png'].description).toBe('oldold oldold');
    expect(await page.evaluate(() => PTFixture.emittedEvents.filter(event => event.type === 'PERSONA_UPDATED'))).toEqual([{ type: 'PERSONA_UPDATED', payload: 'alice.png' }]);
});

test('the modal contains keyboard focus and chat shortcuts on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 450 });
    const dialog = await prepareDescription(page);
    await expect.poll(() => dialog.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 6 && rect.top >= 6 && rect.right <= innerWidth - 6 && rect.bottom <= innerHeight - 6;
    })).toBe(true);
    const find = dialog.getByRole('textbox', { name: 'Find', exact: true });
    await find.focus();
    for (const key of ['Control+Enter', 'Alt+Enter']) await find.press(key);
    expect(await page.evaluate(() => PTFixture.backgroundShortcuts)).toEqual({ send: 0, regenerate: 0, continue: 0 });
    const focusable = dialog.locator('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)').filter({ visible: true });
    await focusable.last().focus();
    await page.keyboard.press('Tab');
    await expect(focusable.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(focusable.last()).toBeFocused();
    await persona(dialog, 'Alice', 'alice.png').focus();
    await page.keyboard.press('Space');
    await expect(persona(dialog, 'Alice', 'alice.png')).not.toBeChecked();
    expect(await page.evaluate(() => PTFixture.selectionCalls)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Find and replace', exact: true })).toBeFocused();
});

test('native button widths and decorative icons keep accessible names and single-line labels', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await loadFixture(page);
    await page.evaluate(() => {
        const nativeStyles = document.createElement('style');
        nativeStyles.textContent = '.menu_button { width: min-content; } .pt-find-replace i::before { content: "ICON"; }';
        document.head.insertBefore(nativeStyles, document.querySelector('link[rel="stylesheet"]'));
    });
    const trigger = page.getByRole('button', { name: 'Find and replace', exact: true });
    await expect(trigger).toBeVisible();
    const dialog = await openReplace(page);
    const labels = [trigger.locator('span'), dialog.getByRole('button', { name: 'Select all results', exact: true }),
        dialog.getByRole('button', { name: 'Clear selection', exact: true }),
        dialog.getByRole('button', { name: 'Preview changes', exact: true }),
        dialog.getByRole('button', { name: 'Apply replacements', exact: true })];
    for (const label of labels) {
        expect(await label.evaluate(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return range.getClientRects().length;
        })).toBe(1);
    }
});
