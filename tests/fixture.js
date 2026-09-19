(() => {
    const seed = window.fixtureSeed || {};
    const saved = JSON.parse(localStorage.getItem('personaToolsFixture') || 'null');
    const extensionSettings = saved || structuredClone(seed.extensionSettings || {});
    const names = seed.personas || { 'alice.png': 'Alice', 'bob.png': 'Bob', 'cara.png': 'Cara' };
    const listeners = new Map();
    const searchData = { persona_search: '' };
    const host = window.PTFixture = {
        extensionSettings,
        legacySettings: seed.legacySettings || {},
        powerUser: { personas: { ...names }, persona_descriptions: seed.descriptions || {} },
        avatars: Object.keys(names),
        currentAvatar: seed.currentAvatar || Object.keys(names)[0],
        page: 1,
        pageSize: seed.pageSize || 5,
        totalPages: 1,
        filtered: [],
        refreshCalls: 0,
        avatarRequests: 0,
        selectionCalls: [],
        saveCalls: 0,
        outsideClicks: 0,
        drawerOpen: true,
        drawerDismissals: 0,
        backgroundShortcuts: { send: 0, regenerate: 0, continue: 0 },
        pendingAvatars: [],
        deferAvatars: false,
        failAvatars: false,
        pendingRenders: [],
        deferRenders: false,
        renderFailure: null,
        renderCompletions: 0,
        ready: false,
        filter: {
            filterFunctions: {},
            getFilterData(key) { return searchData[key]; },
        },
        emit(type, payload) { for (const fn of listeners.get(type) || []) fn(payload); },
        thumbnailUrl(id) {
            const key = seed.avatarCacheKey;
            return key ? `/fixture/cached-avatar.svg?key=${encodeURIComponent(key)}&avatar=${encodeURIComponent(id)}` : `/avatars/${encodeURIComponent(id)}`;
        },
        async reloadAvatarImage(id, revision) {
            if (!seed.avatarCacheKey) throw new Error('avatarCacheKey seed is required');
            const response = await fetch(`/fixture/avatar-cache?key=${encodeURIComponent(seed.avatarCacheKey)}&revision=${revision}`, { method: 'POST' });
            if (!response.ok) throw new Error('Failed to revise fixture avatar');
            await fetch(host.thumbnailUrl(id), { cache: 'reload' });
        },
        flushSaves() { localStorage.setItem('personaToolsFixture', JSON.stringify(extensionSettings)); },
        render() {
            host.renderCompletions++;
            let ids = host.avatars.filter(id => host.powerUser.personas[id].toLowerCase().includes(searchData.persona_search.toLowerCase().trim()));
            for (const filter of Object.values(host.filter.filterFunctions)) ids = filter(ids);
            const direction = document.getElementById('persona_sort').value === 'desc' ? -1 : 1;
            ids.sort((a, b) => direction * host.powerUser.personas[a].localeCompare(host.powerUser.personas[b]));
            host.filtered = ids;
            host.totalPages = Math.max(1, Math.ceil(ids.length / host.pageSize));
            // The fixture keeps the native page until explicitly navigated. An
            // out-of-range page renders empty, making missed extension clamping
            // observable instead of silently fixing it in the mocked host.
            const block = document.getElementById('user_avatar_block');
            block.replaceChildren(...ids.slice((host.page - 1) * host.pageSize, host.page * host.pageSize).map(id => {
                const card = document.createElement('div');
                card.className = 'avatar-container interactable';
                card.setAttribute('data-avatar-id', id);
                card.tabIndex = 0;
                const img = document.createElement('img');
                img.src = host.thumbnailUrl(id);
                img.alt = '';
                const main = document.createElement('div');
                main.className = 'persona-main character_select_container';
                const name = document.createElement('div');
                name.className = 'character_name_block';
                const title = document.createElement('span');
                title.className = 'ch_name';
                title.textContent = host.powerUser.personas[id];
                name.append(title);
                main.append(name);
                card.append(img, main);
                card.addEventListener('click', async () => {
                    const api = await import('/scripts/personas.js');
                    await api.setUserAvatar(id);
                });
                return card;
            }));
            document.getElementById('page-status').textContent = `${host.page} / ${host.totalPages} (${ids.length})`;
        },
        async getUserAvatars(doRender) {
            if (doRender) {
                host.refreshCalls++;
                let failure = host.renderFailure;
                if (host.deferRenders) {
                    failure = await new Promise((resolve, reject) => host.pendingRenders.push({ resolve, reject })) ?? failure;
                }
                if (failure === 'reject') throw new Error('Simulated native render failure');
                if (failure === 'undefined') return undefined;
                if (failure === 'null') return null;
                if (failure === 'object') return { error: 'Unexpected avatar response' };
                host.render();
                return [...host.avatars];
            }
            host.avatarRequests++;
            if (host.failAvatars) throw new Error('Simulated avatar request failure');
            if (host.deferAvatars) return new Promise((resolve, reject) => host.pendingAvatars.push({ resolve, reject }));
            return [...host.avatars];
        },
        resolveAvatars(index = 0, fail = false) {
            const pending = host.pendingAvatars.splice(index, 1)[0];
            if (!pending) throw new Error('No pending avatar request');
            if (fail) pending.reject(new Error('Simulated delayed request failure'));
            else pending.resolve([...host.avatars]);
        },
        resolveRender(index = 0, fail = false) {
            const pending = host.pendingRenders.splice(index, 1)[0];
            if (!pending) throw new Error('No pending native render');
            if (fail === true || fail === 'reject') pending.reject(new Error('Simulated native render failure'));
            else pending.resolve(typeof fail === 'string' ? fail : undefined);
        },
        async selectAvatar(id) {
            host.selectionCalls.push(id);
            host.currentAvatar = id;
            host.emit('PERSONA_CHANGED');
        },
        async duplicate(id, copyId) {
            host.powerUser.personas[copyId] = `${host.powerUser.personas[id]} copy`;
            host.avatars.push(copyId);
            host.emit('PERSONA_CREATED', { avatarId: copyId, duplicatedFromAvatarId: id });
            host.render();
        },
        async delete(id) {
            delete host.powerUser.personas[id];
            host.avatars = host.avatars.filter(item => item !== id);
            host.emit('PERSONA_DELETED', { avatarId: id });
            host.render();
        },
    };
    let saveTimer;
    window.SillyTavern = { getContext: () => ({
        extensionSettings,
        powerUserSettings: host.powerUser,
        saveSettingsDebounced() {
            host.saveCalls++;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(host.flushSaves, 10);
        },
        event_types: Object.fromEntries(['CHAT_CHANGED', 'SETTINGS_UPDATED', 'PERSONA_CHANGED', 'PERSONA_CREATED', 'PERSONA_RENAMED', 'PERSONA_UPDATED', 'PERSONA_DELETED'].map(name => [name, name])),
        eventSource: { on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); } },
        getThumbnailUrl: (_, id) => host.thumbnailUrl(id),
    }) };
    window.jQuery = (arg) => {
        if (typeof arg === 'function') {
            Promise.resolve().then(arg).then(() => { host.ready = true; });
            return;
        }
        if (arg !== '#persona_pagination_container') throw new Error(`Unexpected jQuery selector: ${arg}`);
        return { pagination(action, page) {
            if (action === 'getCurrentPageNum') return host.page;
            if (action === 'getTotalPage') return host.totalPages;
            if (action === 'go') { host.page = page; host.render(); return; }
            throw new Error(`Unexpected pagination operation: ${action}`);
        } };
    };
    document.getElementById('persona_search_bar').addEventListener('input', (event) => {
        searchData.persona_search = event.target.value;
        host.page = 1;
        host.render();
    });
    document.getElementById('persona_sort').addEventListener('change', host.render);
    document.getElementById('grid-toggle').addEventListener('click', () => document.getElementById('user_avatar_block').classList.toggle('gridView'));
    document.getElementById('next-page').addEventListener('click', () => { host.page = Math.min(host.page + 1, host.totalPages); host.render(); });
    document.getElementById('previous-page').addEventListener('click', () => { host.page = Math.max(1, host.page - 1); host.render(); });
    document.getElementById('outside').addEventListener('click', () => { host.outsideClicks++; });
    // Mirror the native html touchstart/mousedown drawer dismissal, recording
    // its state without hiding the fixture or performing any host action.
    for (const type of ['touchstart', 'mousedown']) document.documentElement.addEventListener(type, (event) => {
        if (event.target.closest('.popup, .text_pole, .openDrawer, .drawer-icon')) return;
        if (!host.drawerOpen) return;
        host.drawerOpen = false;
        host.drawerDismissals++;
        const panel = document.getElementById('persona-management-block');
        panel.classList.remove('openDrawer');
        panel.dataset.fixtureDrawerOpen = 'false';
    });
    // Native global chat shortcuts run before its generic focused-input guard.
    // These counters let modal tests verify containment without sending a chat.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        if (event.altKey) host.backgroundShortcuts.continue++;
        else if (event.ctrlKey) {
            host.backgroundShortcuts[document.getElementById('chat-input').value ? 'send' : 'regenerate']++;
        }
    });
    // Match the host's bubbling Enter synthesizer (including its disregard for
    // defaultPrevented) to catch double activation and accidental card selection.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.shiftKey) return;
        const control = event.target.closest('.menu_button, .interactable');
        if (control) control.click();
    });
    host.render();
})();
