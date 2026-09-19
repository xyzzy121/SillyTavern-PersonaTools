import { test as base, expect } from '@playwright/test';

// Expected request failures are caught and logged by the extension. An uncaught
// browser exception is always a regression, even if later DOM assertions pass.
export const test = base.extend({
    page: async ({ page }, use) => {
        const errors = [];
        const recordError = error => errors.push(error.stack || error.message);
        page.on('pageerror', recordError);
        try {
            await use(page);
        } finally {
            page.off('pageerror', recordError);
            expect(errors, 'Uncaught browser errors').toEqual([]);
        }
    },
});

export { expect };

// Wait for scheduled paint work, not pending network requests or debounce timers.
export async function nextPaint(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function waitForFixture(page) {
    await page.waitForFunction(() => window.PTFixture?.ready);
    await expect(page.locator('#quickPersona')).toHaveCount(1);
    await nextPaint(page);
}

export async function loadFixture(page, seed = {}) {
    // Migration scenarios intentionally omit settings keys; do not fill defaults.
    await page.addInitScript(value => { window.fixtureSeed = value; }, seed);
    await page.goto('/');
    await waitForFixture(page);
}

export async function persistAndReload(page) {
    await page.evaluate(() => window.PTFixture.flushSaves());
    await page.reload();
    await waitForFixture(page);
}
