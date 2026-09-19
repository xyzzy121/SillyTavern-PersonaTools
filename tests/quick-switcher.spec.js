import { test, expect, loadFixture, nextPaint } from './helpers.js';

async function deferRequests(page) {
    await page.evaluate(() => { window.PTFixture.deferAvatars = true; });
}

async function expectClosed(page) {
    await expect(page.locator('#quickPersonaMenu')).toHaveCount(0);
    await expect(page.locator('#quickPersona')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#quickPersona')).not.toHaveAttribute('aria-busy', 'true');
}

test('small menu receives focus and selects a persona once with Enter', async ({ page }) => {
    await loadFixture(page);
    const trigger = page.locator('#quickPersona');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const menu = page.locator('#quickPersonaMenu');
    await expect(menu).toBeFocused();
    await expect(menu.locator('.pt-quick-search')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const bob = menu.getByRole('menuitemradio', { name: 'Bob', exact: true });
    await expect(bob).toHaveClass(/pt-active/);
    await expect(menu).toHaveAttribute('aria-activedescendant', await bob.getAttribute('id'));
    await page.keyboard.press('Enter');

    await expectClosed(page);
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.PTFixture.selectionCalls)).toEqual(['bob.png']);
    await nextPaint(page);
    await expectClosed(page);
    expect(await page.evaluate(() => window.PTFixture.avatarRequests)).toBe(1);
});

test('keyboard folder activation keeps the small menu open and exposes expansion', async ({ page }) => {
    await loadFixture(page, {
        currentAvatar: 'alice.png',
        extensionSettings: { PersonaTools: { personaGroups: { 'bob.png': ['Friends'] } } },
    });
    await page.locator('#quickPersona').focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('#quickPersonaMenu');
    const folder = menu.getByRole('menuitem', { name: /Friends/ });
    const bob = menu.getByRole('menuitemradio', { name: 'Bob', exact: true });
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(bob).toBeHidden();

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(menu).toBeFocused();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(bob).toBeVisible();
    expect(await page.evaluate(() => window.PTFixture.selectionCalls)).toEqual([]);

    await page.keyboard.press('Enter');
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(bob).toBeHidden();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('#quickPersona')).toBeFocused();
});

test('large menu focuses search and activates a filtered persona once', async ({ page }) => {
    await loadFixture(page, {
        personas: {
            'alice.png': 'Alice', 'bob.png': 'Bob', 'cara.png': 'Cara', 'dora.png': 'Dora',
            'erin.png': 'Erin', 'faye.png': 'Faye', 'gina.png': 'Gina',
        },
    });
    await page.locator('#quickPersona').click();
    const menu = page.locator('#quickPersonaMenu');
    const search = menu.getByRole('searchbox', { name: 'Search personas' });
    await expect(search).toBeFocused();
    await search.fill('Gina');
    await expect(menu.getByRole('menuitemradio')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    const gina = menu.getByRole('menuitemradio', { name: 'Gina', exact: true });
    await expect(search).toHaveAttribute('aria-activedescendant', await gina.getAttribute('id'));
    await page.keyboard.press('Enter');
    await expectClosed(page);
    await expect(page.locator('#quickPersona')).toBeFocused();
    expect(await page.evaluate(() => window.PTFixture.selectionCalls)).toEqual(['gina.png']);
    expect(await page.evaluate(() => window.PTFixture.avatarRequests)).toBe(1);
});

test('Tab dismisses the menu and later chat keys are not intercepted', async ({ page }) => {
    await loadFixture(page);
    await page.locator('#quickPersona').click();
    await expect(page.locator('#quickPersonaMenu')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+Tab');
    await expectClosed(page);
    await expect(page.locator('#outside')).toBeFocused();

    await page.locator('#chat-input').focus();
    await page.evaluate(() => {
        window.chatKeyEvents = [];
        document.getElementById('chat-input').addEventListener('keydown', event => {
            window.chatKeyEvents.push({ key: event.key, prevented: event.defaultPrevented });
        });
    });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.chatKeyEvents)).toEqual([
        { key: 'ArrowDown', prevented: false }, { key: 'Enter', prevented: false },
    ]);
    expect(await page.evaluate(() => window.PTFixture.selectionCalls)).toEqual([]);
    await expect(page.locator('#chat-input')).toBeFocused();
});

test('repeated toggle cancels an opening menu without another avatar request', async ({ page }) => {
    await loadFixture(page);
    await deferRequests(page);
    const trigger = page.locator('#quickPersona');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-busy', 'true');
    await trigger.click();
    await expectClosed(page);
    expect(await page.evaluate(() => window.PTFixture.avatarRequests)).toBe(1);
    expect(await page.evaluate(() => window.PTFixture.pendingAvatars.length)).toBe(1);
    await page.evaluate(() => window.PTFixture.resolveAvatars());
    await nextPaint(page);
    await expectClosed(page);
    await expect(trigger).toBeFocused();
});

for (const dismissal of ['outside click', 'outside focus', 'Escape']) {
    test(`${dismissal} cancels an opening menu and ignores its late result`, async ({ page }) => {
        await loadFixture(page);
        await deferRequests(page);
        const trigger = page.locator('#quickPersona');
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-busy', 'true');
        if (dismissal === 'outside click') await page.locator('#outside').click();
        else if (dismissal === 'outside focus') await page.locator('#chat-input').focus();
        else await page.keyboard.press('Escape');
        await expectClosed(page);
        await page.evaluate(() => window.PTFixture.resolveAvatars());
        await nextPaint(page);
        await expectClosed(page);
        const focusTarget = dismissal === 'Escape' ? trigger : page.locator(dismissal === 'outside click' ? '#outside' : '#chat-input');
        await expect(focusTarget).toBeFocused();
        expect(await page.evaluate(() => window.PTFixture.selectionCalls)).toEqual([]);
    });
}

for (const staleFailure of [false, true]) {
    test(`stale ${staleFailure ? 'failure' : 'success'} cannot close or replace a newer menu`, async ({ page }) => {
        await loadFixture(page);
        await deferRequests(page);
        const errors = [];
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const trigger = page.locator('#quickPersona');
        await trigger.click();
        await trigger.click();
        await trigger.click();
        expect(await page.evaluate(() => window.PTFixture.pendingAvatars.length)).toBe(2);
        expect(await page.evaluate(() => window.PTFixture.avatarRequests)).toBe(2);

        await page.evaluate(() => window.PTFixture.resolveAvatars(1));
        const menu = page.locator('#quickPersonaMenu');
        await expect(menu).toBeFocused();
        await page.keyboard.press('ArrowDown');
        const activeRow = await menu.getAttribute('aria-activedescendant');
        await page.evaluate(fail => window.PTFixture.resolveAvatars(0, fail), staleFailure);
        await nextPaint(page);
        await expect(menu).toBeFocused();
        await expect(menu).toHaveAttribute('aria-activedescendant', activeRow);
        await expect(page.locator('.pt-quick-menu')).toHaveCount(1);
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        expect(errors).toEqual([]);
    });
}

test('a failed avatar request clears opening state and permits retry', async ({ page }) => {
    await loadFixture(page);
    await page.evaluate(() => { window.PTFixture.failAvatars = true; });
    await page.locator('#quickPersona').click();
    await expectClosed(page);
    await expect(page.locator('#quickPersona')).toBeFocused();
    await page.evaluate(() => { window.PTFixture.failAvatars = false; });
    await page.locator('#quickPersona').click();
    await expect(page.locator('#quickPersonaMenu')).toBeFocused();
    expect(await page.evaluate(() => window.PTFixture.avatarRequests)).toBe(2);
});

for (const responseType of ['undefined', 'null', 'object']) {
    test(`a current ${responseType} avatar response closes without an empty menu`, async ({ page }) => {
        await loadFixture(page);
        await page.evaluate(type => {
            const original = window.PTFixture.getUserAvatars.bind(window.PTFixture);
            window.PTFixture.getUserAvatars = async doRender => {
                if (doRender) return original(doRender);
                if (type === 'undefined') return undefined;
                if (type === 'null') return null;
                return {};
            };
        }, responseType);
        await page.locator('#quickPersona').click();
        await nextPaint(page);
        await expectClosed(page);
        await expect(page.locator('#quickPersona')).toBeFocused();
        expect(await page.evaluate(() => window.PTFixture.selectionCalls)).toEqual([]);
    });
}

test('an empty avatar array still opens a keyboard-dismissible menu', async ({ page }) => {
    await loadFixture(page);
    await page.evaluate(() => {
        const original = window.PTFixture.getUserAvatars.bind(window.PTFixture);
        window.PTFixture.getUserAvatars = async doRender => doRender ? original(doRender) : [];
    });
    await page.locator('#quickPersona').click();
    const menu = page.locator('#quickPersonaMenu');
    await expect(menu).toBeFocused();
    await expect(menu.locator('.pt-quick-header-count')).toHaveText('0');
    await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toBeFocused();
    expect(await page.evaluate(() => window.PTFixture.selectionCalls)).toEqual([]);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('#quickPersona')).toBeFocused();
});
