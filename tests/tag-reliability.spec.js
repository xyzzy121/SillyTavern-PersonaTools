import { test, expect, loadFixture } from './helpers.js';

async function boot(page, tags, assignments = {}) {
    await loadFixture(page, {
        extensionSettings: { PersonaTools: {
            personaGroups: {}, folderDescriptions: {}, persona_tags: tags, persona_tag_map: assignments,
        } },
    });
}

test('an active tag query remains editable when deletion crosses the search threshold', async ({ page }) => {
    const tags = Array.from({ length: 7 }, (_, i) => ({ id: `tag${i}`, name: `Tag ${i}`, color: '#aaccee' }));
    await boot(page, tags);
    await page.getByRole('button', { name: 'Filter by tags', exact: true }).click();
    const search = page.getByRole('searchbox', { name: 'Filter tags', exact: true });
    await search.fill('Tag 0');
    await page.locator('[data-avatar-id="alice.png"] [title="Tags"]').click();
    await page.getByRole('button', { name: 'Delete Tag 0 everywhere', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm delete Tag 0 everywhere', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(search).toBeVisible();
    await expect(search).toHaveValue('Tag 0');
    await expect(page.locator('.pt-tag-bar-chips')).toHaveText('No matching tags');
    await search.fill('');
    await expect(page.locator('.pt-tag-bar-chips button')).toHaveCount(6);
    await page.getByRole('button', { name: 'Filter by tags', exact: true }).click();
    await page.getByRole('button', { name: 'Filter by tags', exact: true }).click();
    await expect(page.locator('.pt-tag-bar-chips button')).toHaveCount(6);
});

test('mobile tag toggle retains its purpose and count across selection and collapse', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, [
        { id: 'one', name: 'One', color: '#aaccff' },
        { id: 'two', name: 'Two', color: '#ffccaa' },
    ], { 'alice.png': ['one', 'two'] });
    const toggle = page.locator('.pt-tag-bar-toggle');
    await expect(toggle).toHaveAccessibleName('Filter by tags');
    await toggle.click();
    await page.locator('.pt-tag-bar-chips button').filter({ hasText: 'One' }).click();
    await expect(toggle).toHaveAccessibleName('Filter by tags, 1 active');
    await page.locator('.pt-tag-bar-chips button').filter({ hasText: 'Two' }).click();
    await expect(toggle).toHaveAccessibleName('Filter by tags, 2 active');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAccessibleName('Filter by tags, 2 active');
    await toggle.click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(toggle).toHaveAccessibleName('Filter by tags');
});

test('rendered tag text meets contrast for bright, dark, light and midtone picker colors', async ({ page }) => {
    const colors = ['#00ee00', '#ff0000', '#131313', '#fffff0', '#777777', '#fff'];
    const tags = colors.map((color, i) => ({ id: `color${i}`, name: `Color ${i}`, color }));
    await boot(page, tags, { 'alice.png': tags.map(tag => tag.id) });
    const chips = page.locator('[data-avatar-id="alice.png"] .pt-card-tags button');
    await expect(chips).toHaveCount(colors.length);
    const rendered = await chips.evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return { text: style.color, background: style.backgroundColor };
    }));
    const luminance = rgb => {
        const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
            value /= 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    for (const { text, background } of rendered) {
        const values = [luminance(text), luminance(background)].sort((a, b) => b - a);
        expect((values[0] + 0.05) / (values[1] + 0.05), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(rendered[0].text).toBe('rgb(0, 0, 0)');
});
