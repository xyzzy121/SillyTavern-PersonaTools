/**
 * PersonaTools — persona folders, tags and a quick switcher for SillyTavern.
 *
 * v2.0.0 architecture: instead of cloning and hiding SillyTavern's rendered
 * persona cards (which fought pagination, search and sorting), PersonaTools
 * injects a filter function into ST's own `personasFilter`. Folder and tag
 * views therefore filter the native list: cards stay fully native (locks,
 * default-persona star, selection), pagination paginates the filtered set,
 * and the built-in search box keeps working. PersonaTools only *adds* DOM:
 * folder cards at the top of the list, small per-card action buttons, tag
 * chips, a breadcrumb header and the quick-switcher menu.
 *
 * Author: LukaTheHero
 */
(() => {
    'use strict';

    const EXT_NAME = 'PersonaTools';
    const VERSION = '2.0.3';
    // PersonaTools' entry in personasFilter.filterFunctions. Namespaced to never
    // collide with ST's own FILTER_TYPES keys.
    const FILTER_KEY = 'personaTools__view';
    // ST's FILTER_TYPES.PERSONA_SEARCH — the key the native search box writes to.
    const ST_SEARCH_KEY = 'persona_search';

    const context = SillyTavern.getContext();
    const { extensionSettings, saveSettingsDebounced, eventSource, event_types, getThumbnailUrl } = context;

    let powerUser = context.powerUserSettings || null;
    let personasApi = null;   // module namespace of /scripts/personas.js (live bindings)

    function error(...args) { console.error(`[${EXT_NAME}]`, ...args); }

    // ============================================
    // DOM HELPERS (no HTML-string interpolation anywhere — persona names,
    // folder names, descriptions and tag names are all user-controlled)
    // ============================================

    function isComposingKey(event) {
        return event.isComposing || event.keyCode === 229;
    }

    /**
     * @param {string} tag
     * @param {{cls?: string, text?: string, title?: string, attrs?: Object.<string,string>, on?: Object.<string,Function>}} [opts]
     * @param {...(Node|string|null|undefined)} children
     */
    function el(tag, opts = {}, ...children) {
        const node = document.createElement(tag);
        if (opts.cls) node.className = opts.cls;
        if (opts.text !== undefined) node.textContent = opts.text;
        if (opts.title) node.title = opts.title;
        if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
        if (opts.on) for (const [k, v] of Object.entries(opts.on)) node.addEventListener(k, v);
        if (tag === 'button') {
            // ST's global keyboard handler (keyboard.js) synthesizes click() on
            // Enter for any .menu_button/.interactable ancestor without checking
            // defaultPrevented — on a native button that means double activation
            // (or activating the enclosing persona card). Stop the keydown from
            // bubbling; native button activation still fires exactly one click.
            node.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    if (e.repeat || isComposingKey(e)) e.preventDefault();
                }
            });
        }
        for (const child of children) {
            if (child === null || child === undefined) continue;
            node.append(child);
        }
        return node;
    }

    /** Font Awesome icon element. Class list is always a constant string. */
    function icon(faClasses) {
        return el('i', { cls: `fa-solid fa-fw ${faClasses}` });
    }

    function debounced(fn, ms) {
        let handle = null;
        return (...args) => {
            clearTimeout(handle);
            handle = setTimeout(() => fn(...args), ms);
        };
    }

    /** Thumbnail URL without cache busting — ST's server-side thumbnails are stable. */
    function thumbUrl(avatarId) {
        try { return getThumbnailUrl('persona', avatarId); }
        catch { return `/user/avatars/${encodeURIComponent(avatarId)}`; }
    }

    /**
     * Black or white text for a given hex background, so light tag colors stay
     * readable (v1 forced white text on pastel backgrounds).
     */
    function contrastColor(hex) {
        const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
        if (!m) return '#fff';
        const digits = m[1].length === 3 ? [...m[1]].map(d => d + d).join('') : m[1];
        const n = parseInt(digits, 16);
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        const linear = value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        };
        const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
    }

    function styleTagChip(node, color) {
        node.style.backgroundColor = color;
        node.style.color = contrastColor(color);
    }

    // ============================================
    // SETTINGS
    // ============================================

    const defaultSettings = Object.freeze({
        personaGroups: {},        // avatarId -> [folderName]
        persona_tags: [],         // [{id, name, color}]
        persona_tag_map: {},      // avatarId -> [tagId]
        folderDescriptions: {},   // folderName -> description
    });

    let settings = {};

    function getSettings() {
        if (!extensionSettings[EXT_NAME]) extensionSettings[EXT_NAME] = structuredClone(defaultSettings);
        for (const key of Object.keys(defaultSettings)) {
            if (!(key in extensionSettings[EXT_NAME])) extensionSettings[EXT_NAME][key] = structuredClone(defaultSettings[key]);
        }
        return extensionSettings[EXT_NAME];
    }

    function saveSettings() {
        saveSettingsDebounced();
    }

    async function migrateFromOldExtensions() {
        let changed = false;
        const pgm = extensionSettings['personas'];
        if (pgm && !settings._migratedPGM) {
            if (pgm.personaGroups && Object.keys(pgm.personaGroups).length > 0 && Object.keys(settings.personaGroups).length === 0) {
                settings.personaGroups = structuredClone(pgm.personaGroups);
            }
            settings._migratedPGM = true;
            changed = true;
        }

        if (!settings._migratedTags) {
            // PersonaTags uses extensionSettings on current ST and root settings
            // on older releases. Always take the definitions and map together.
            const readLegacyTags = (source) => {
                if (!source) return null;
                const tags = Array.isArray(source.persona_tags) ? source.persona_tags : null;
                const map = source.persona_tag_map && typeof source.persona_tag_map === 'object' && !Array.isArray(source.persona_tag_map)
                    ? source.persona_tag_map : null;
                return tags || map ? { tags: tags || [], map: map || {} } : null;
            };
            const hasData = (source) => source && (source.tags.length > 0 || Object.keys(source.map).length > 0);
            let legacy = readLegacyTags(extensionSettings);
            if (!hasData(legacy)) {
                let historical = null;
                try { historical = readLegacyTags((await import('/script.js')).settings); } catch { /* older ST */ }
                if (hasData(historical) || !legacy) legacy = historical;
            }

            if (legacy) {
                if (settings.persona_tags.length === 0 && Object.keys(settings.persona_tag_map).length === 0) {
                    settings.persona_tags = structuredClone(legacy.tags);
                    settings.persona_tag_map = structuredClone(legacy.map);
                } else if (hasData(legacy)) {
                    console.info(`[${EXT_NAME}] Skipped legacy tag import because PersonaTools already contains tag data.`);
                }
                settings._migratedTags = true;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Drop descriptions of folders that no longer appear in any persona's
     * folder list, so an emptied folder's description can't silently resurrect
     * on a future folder with the same name.
     */
    function pruneOrphanDescriptions() {
        const live = new Set();
        for (const folders of Object.values(settings.personaGroups)) folders.forEach(f => live.add(f));
        let pruned = false;
        for (const name of Object.keys(settings.folderDescriptions)) {
            if (!live.has(name)) { delete settings.folderDescriptions[name]; pruned = true; }
        }
        return pruned;
    }

    // ============================================
    // PERSONA DATA
    // ============================================

    function personaExists(avatarId) {
        return !!(powerUser && powerUser.personas && Object.hasOwn(powerUser.personas, avatarId));
    }

    function getPersonaName(avatarId) {
        return (powerUser && powerUser.personas && powerUser.personas[avatarId]) || avatarId;
    }

    function getPersonaTitle(avatarId) {
        return (powerUser && powerUser.persona_descriptions && powerUser.persona_descriptions[avatarId]?.title) || '';
    }

    function getCurrentAvatar() {
        return personasApi ? personasApi.user_avatar : null;
    }

    // ============================================
    // FOLDER DATA
    // ============================================

    function getFoldersOf(avatarId) {
        return settings.personaGroups[avatarId] || [];
    }

    function getFolderDescription(folderName) {
        if (!Object.hasOwn(settings.folderDescriptions, folderName)) return '';
        const description = settings.folderDescriptions[folderName];
        return typeof description === 'string' ? description : '';
    }

    function setFolderDescription(folderName, description) {
        if (typeof description !== 'string' || !description) {
            if (!Object.hasOwn(settings.folderDescriptions, folderName)) return false;
            delete settings.folderDescriptions[folderName];
            return true;
        }
        if (Object.hasOwn(settings.folderDescriptions, folderName) && settings.folderDescriptions[folderName] === description) return false;
        Object.defineProperty(settings.folderDescriptions, folderName, {
            value: description, writable: true, enumerable: true, configurable: true,
        });
        return true;
    }

    function isGrouped(avatarId) {
        return getFoldersOf(avatarId).length > 0;
    }

    /** Folder members, ghosts (deleted personas) excluded. */
    function getFolderMembers(folderName) {
        const members = [];
        for (const [avatarId, folders] of Object.entries(settings.personaGroups)) {
            if (folders.includes(folderName) && personaExists(avatarId)) members.push(avatarId);
        }
        return members;
    }

    function getAllFolders() {
        const names = new Set();
        for (const folders of Object.values(settings.personaGroups)) folders.forEach(f => names.add(f));
        return [...names]
            .map(name => ({ name, members: getFolderMembers(name) }))
            .filter(f => f.members.length > 0)
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    function addToFolder(avatarId, folderName) {
        if (!personaExists(avatarId)) return false;
        if (!settings.personaGroups[avatarId]) settings.personaGroups[avatarId] = [];
        if (settings.personaGroups[avatarId].includes(folderName)) return false;
        settings.personaGroups[avatarId].push(folderName);
        return true;
    }

    function folderStillReferenced(folderName) {
        return Object.values(settings.personaGroups).some(folders => folders.includes(folderName));
    }

    function removeFromFolder(avatarId, folderName) {
        const folders = settings.personaGroups[avatarId];
        if (!folders) return false;
        const idx = folders.indexOf(folderName);
        if (idx < 0) return false;
        folders.splice(idx, 1);
        if (folders.length === 0) delete settings.personaGroups[avatarId];
        if (!folderStillReferenced(folderName)) setFolderDescription(folderName, '');
        return true;
    }

    function renameFolder(oldName, newName) {
        if (!newName || newName === oldName) return false;
        let changed = false;
        for (const folders of Object.values(settings.personaGroups)) {
            const idx = folders.indexOf(oldName);
            if (idx > -1) {
                if (folders.includes(newName)) folders.splice(idx, 1); // merging into an existing folder
                else folders[idx] = newName;
                changed = true;
            }
        }
        if (getFolderDescription(oldName) && !getFolderDescription(newName)) {
            changed = setFolderDescription(newName, getFolderDescription(oldName)) || changed;
        }
        return setFolderDescription(oldName, '') || changed;
    }

    function deleteFolder(folderName) {
        let changed = false;
        for (const [avatarId, folders] of Object.entries(settings.personaGroups)) {
            const idx = folders.indexOf(folderName);
            if (idx > -1) {
                folders.splice(idx, 1);
                if (folders.length === 0) delete settings.personaGroups[avatarId];
                changed = true;
            }
        }
        return setFolderDescription(folderName, '') || changed;
    }

    // ============================================
    // TAG DATA
    // ============================================

    function getTag(tagId) {
        return settings.persona_tags.find(t => t.id === tagId);
    }

    function getTagsOf(avatarId) {
        return (settings.persona_tag_map[avatarId] || []).map(getTag).filter(Boolean);
    }

    function getTagUsage(tagId) {
        let count = 0;
        for (const [avatarId, tags] of Object.entries(settings.persona_tag_map)) {
            if (tags.includes(tagId) && personaExists(avatarId)) count++;
        }
        return count;
    }

    function createTag(name, color) {
        const tag = { id: `tag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, color };
        settings.persona_tags.push(tag);
        return tag;
    }

    function deleteTag(tagId) {
        const remaining = settings.persona_tags.filter(t => t.id !== tagId);
        let changed = remaining.length !== settings.persona_tags.length;
        if (changed) settings.persona_tags = remaining;
        for (const [avatarId, tags] of Object.entries(settings.persona_tag_map)) {
            const next = tags.filter(t => t !== tagId);
            if (next.length === tags.length && next.length) continue;
            if (next.length) settings.persona_tag_map[avatarId] = next;
            else delete settings.persona_tag_map[avatarId];
            changed = true;
        }
        return changed;
    }

    function toggleTagOn(avatarId, tagId) {
        if (!personaExists(avatarId) || !getTag(tagId)) return false;
        const tags = settings.persona_tag_map[avatarId] || [];
        const next = tags.includes(tagId) ? tags.filter(t => t !== tagId) : [...tags, tagId];
        if (next.length) settings.persona_tag_map[avatarId] = next;
        else delete settings.persona_tag_map[avatarId];
        return true;
    }

    function hasAllTags(avatarId, tagIds) {
        const assigned = settings.persona_tag_map[avatarId] || [];
        return tagIds.every(t => assigned.includes(t));
    }

    let lightColors = true;
    function randomTagColor() {
        const channel = () => lightColors ? 150 + Math.floor(Math.random() * 90) : 40 + Math.floor(Math.random() * 110);
        return '#' + [channel(), channel(), channel()].map(x => x.toString(16).padStart(2, '0')).join('');
    }

    // ============================================
    // VIEW STATE + NATIVE FILTER INJECTION
    // ============================================

    const view = {
        folder: null,   // open folder name, or null for root
        tags: [],       // selected tag-filter ids (AND semantics)
    };

    function isSearchActive() {
        try {
            const term = personasApi.personasFilter.getFilterData(ST_SEARCH_KEY);
            return !!(term && String(term).trim().length);
        } catch { return false; }
    }

    /**
     * The filter ST runs while rendering the persona list. Receives the array
     * of avatar ids and returns the subset to display. Must never throw.
     */
    function personaToolsFilter(avatarIds) {
        try {
            if (!Array.isArray(avatarIds)) return avatarIds;
            let data = avatarIds;
            // Tag filters compose with the native search (AND)...
            if (view.tags.length) data = data.filter(id => hasAllTags(id, view.tags));
            // ...but searching bypasses folder scoping, so it finds everything.
            if (isSearchActive()) return data;
            if (view.folder) {
                const members = new Set(getFolderMembers(view.folder));
                return data.filter(id => members.has(id));
            }
            if (view.tags.length) return data;
            if (getAllFolders().length) return data.filter(id => !isGrouped(id));
            return data;
        } catch (e) {
            error('filter failed, passing through', e);
            return avatarIds;
        }
    }

    let avatarSyncQueued = false;

    function installFilter() {
        personasApi.personasFilter.filterFunctions[FILTER_KEY] = (avatarIds) => {
            // Native rendering reaches this hook even when no personas match.
            // An upload has refreshed the HTTP cache before this point; rebind
            // the stable URL once after rendering, including an unchanged ID.
            if (Array.isArray(avatarIds) && !avatarSyncQueued) {
                avatarSyncQueued = true;
                requestAnimationFrame(() => {
                    avatarSyncQueued = false;
                    updateQuickButton(true);
                });
            }
            return personaToolsFilter(avatarIds);
        };
    }

    function getPaginationPage() {
        try { return jQuery('#persona_pagination_container').pagination('getCurrentPageNum') || 1; }
        catch { return 1; }
    }

    function gotoPaginationPage(page) {
        try {
            const container = jQuery('#persona_pagination_container');
            const total = container.pagination('getTotalPage');
            const target = Math.max(1, Math.min(page, total || 1));
            if (container.pagination('getCurrentPageNum') !== target) container.pagination('go', target);
        } catch { /* pagination not initialized yet */ }
    }

    // The root list's page, remembered while a folder/tag view is open so
    // going back doesn't dump the user on a different page.
    let rootListPage = 1;
    let listRefreshRequest = 0;
    let failedListPage = 1;
    let listError = null;

    function setListError(failed) {
        const panel = document.querySelector(SEL.panel);
        const block = document.querySelector(SEL.block);
        if (!panel || !block) return;
        if (failed && !listError) {
            listError = el('div', { cls: 'pt-list-error', attrs: { id: 'pt-list-error' } },
                el('span', { text: 'Could not load personas. Please try again.', attrs: { role: 'alert' } }),
                el('button', {
                    cls: 'menu_button', text: 'Retry',
                    attrs: { type: 'button', 'data-pt-focus': 'retry-personas' },
                    on: { click: () => refreshList(failedListPage) },
                }),
            );
            block.insertAdjacentElement('beforebegin', listError);
        }
        const restoreFocus = rememberFocus(panel, { fallback: focusPersonaPanel });
        panel.classList.toggle('pt-list-failed', failed);
        // Both mouse and assistive-technology access must exclude stale cards.
        block.classList.toggle('pt-hidden', failed);
        document.getElementById('persona_pagination_container')?.classList.toggle('pt-hidden', failed);
        if (listError) {
            listError.hidden = !failed;
            listError.querySelector('button').disabled = false;
            listError.removeAttribute('aria-busy');
        }
        restoreFocus();
    }

    /** Re-render ST's persona list through the filters, then re-decorate. */
    async function refreshList(page = 0) {
        const request = ++listRefreshRequest;
        const targetPage = page > 0 ? page : getPaginationPage();
        const panel = document.querySelector(SEL.panel);
        if (panel?.contains(document.activeElement)) {
            restorePanelFocus = rememberFocus(panel, { fallback: focusPersonaPanel });
        }
        if (listError && !listError.hidden) {
            listError.querySelector('button').disabled = true;
            listError.setAttribute('aria-busy', 'true');
        }
        try {
            const avatars = await personasApi.getUserAvatars(true);
            if (request !== listRefreshRequest) return;
            if (!Array.isArray(avatars)) throw new Error('Avatar request did not return a persona list');
        } catch (e) {
            if (request !== listRefreshRequest) return;
            failedListPage = targetPage;
            setListError(true);
            scheduleDecorate();
            error('refreshList failed', e);
            return;
        }
        setListError(false);
        gotoPaginationPage(targetPage);
        scheduleDecorate();
    }
    const refreshListSoon = debounced(refreshList, 150);

    function refreshAfterTagChange(tagId) {
        if (view.tags.includes(tagId)) refreshListSoon();
        else scheduleDecorate();
    }

    function isRootView() { return !view.folder && !view.tags.length; }

    /** Central view-state switch that keeps pagination positions sane. */
    function changeView(mutate) {
        const wasRoot = isRootView();
        if (wasRoot) rootListPage = getPaginationPage();
        mutate();
        const isRoot = isRootView();
        return refreshList(isRoot ? (wasRoot ? 0 : rootListPage) : 1);
    }

    // ============================================
    // DECORATION — folder cards, per-card buttons, tag chips, header
    // ============================================

    const SEL = {
        panel: '#persona-management-block',
        headerRow: '#persona-management-block .persona_management_left_column .flex-container.marginBot10.alignitemscenter',
        block: '#user_avatar_block',
        card: '.avatar-container',
        nameBlock: '.character_name_block',
    };

    let decorateQueued = false;
    let restorePanelFocus = () => {};

    function scheduleDecorate() {
        if (decorateQueued) return;
        decorateQueued = true;
        requestAnimationFrame(() => {
            decorateQueued = false;
            decorate();
        });
    }

    function decorate() {
        const block = document.querySelector(SEL.block);
        if (!block) return;
        const restoreFocus = rememberFocus(document.querySelector(SEL.panel), { fallback: focusPersonaPanel });
        renderFolderCards(block);
        decorateNativeCards(block);
        updateFolderHeader();
        renderTagBar();
        createFindReplaceButton();
        // With every persona foldered, the root list has zero native entries and
        // ST's pagination navigator renders a confusing "1-0 .. 0" — hide it.
        const panel = document.querySelector(SEL.panel);
        if (panel) {
            const hasNative = !!block.querySelector(`${SEL.card}:not(.pt-folder-card)`);
            const hasFolders = !!block.querySelector('.pt-folder-card');
            panel.classList.toggle('pt-root-empty', hasFolders && !hasNative);
        }
        restoreFocus();
        restorePanelFocus();
    }

    /**
     * True when a mutation batch needs a re-decorate. Our own decorate() pass
     * removes AND re-adds .pt-injected folder cards in one batch; a batch that
     * only REMOVES them is ST's empty() hitting a list with no native cards
     * (e.g. sort change while every persona is foldered) and must re-decorate,
     * or the panel would stay blank.
     */
    function hasForeignMutations(records) {
        let injectedAdded = false;
        let injectedRemoved = false;
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE || !node.classList.contains('pt-injected')) return true;
                injectedAdded = true;
            }
            for (const node of record.removedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE || !node.classList.contains('pt-injected')) return true;
                injectedRemoved = true;
            }
        }
        return injectedRemoved && !injectedAdded;
    }

    function startObserver() {
        const block = document.querySelector(SEL.block);
        if (!block) return;
        // A popover can hand focus back after a native refresh starts but before
        // it replaces the cards. Remember focus changes, not just request-start
        // focus, so that late replacement still restores the logical control.
        document.addEventListener('focusin', () => {
            restorePanelFocus = rememberFocus(document.querySelector(SEL.panel), { fallback: focusPersonaPanel });
        }, true);
        document.addEventListener('pointerdown', () => { restorePanelFocus = () => {}; }, true);
        window.addEventListener('blur', () => { restorePanelFocus = () => {}; });
        const observer = new MutationObserver((records) => {
            if (hasForeignMutations(records)) scheduleDecorate();
        });
        observer.observe(block, { childList: true });
    }

    // --- Folder cards ---

    function renderFolderCards(block) {
        block.querySelectorAll('.pt-folder-card').forEach(n => n.remove());
        const showFolders = !view.folder && !view.tags.length && !isSearchActive();
        if (!showFolders) return;

        const fragment = document.createDocumentFragment();
        for (const { name, members } of getAllFolders()) {
            fragment.append(buildFolderCard(name, members));
        }
        block.prepend(fragment);
    }

    function buildFolderCard(name, members) {
        const stack = el('div', { cls: 'pt-folder-avatars' });
        for (const id of members.slice(0, 3)) {
            stack.append(el('img', { cls: 'pt-folder-thumb', attrs: { src: thumbUrl(id), alt: '', loading: 'lazy' } }));
        }
        stack.append(el('div', { cls: 'pt-folder-avatars-badge' }, icon('fa-folder')));

        const titleRow = el('div', { cls: 'pt-folder-title-row' },
            el('span', { cls: 'pt-folder-name', text: name }),
            el('span', { cls: 'pt-folder-count', text: String(members.length) }),
        );
        const body = el('div', { cls: 'pt-folder-body' }, titleRow);
        const desc = getFolderDescription(name);
        if (desc) body.append(el('div', { cls: 'pt-folder-desc', text: desc }));

        const editBtn = el('button', {
            cls: 'pt-icon-btn pt-folder-edit', title: 'Edit folder',
            attrs: { type: 'button', 'data-pt-focus': `edit-folder:${name}` },
            on: {
                click: (e) => { e.stopPropagation(); openFolderEditor(editBtn, name); },
                mousedown: (e) => e.stopPropagation(),
            },
        }, icon('fa-pen'));

        const open = () => changeView(() => { view.folder = name; });
        return el('div', {
            cls: 'pt-folder-card pt-injected',
            attrs: { role: 'button', tabindex: '0', 'data-folder': name, 'data-pt-focus': `folder:${name}` },
            on: {
                click: open,
                keydown: (e) => {
                    if (e.target !== e.currentTarget) return; // let the edit button handle its own keys
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
                },
            },
        }, stack, body, editBtn);
    }

    // --- Native card buttons + tag chips ---

    function decorateNativeCards(block) {
        for (const card of block.querySelectorAll(`${SEL.card}:not(.pt-folder-card)`)) {
            const avatarId = card.getAttribute('data-avatar-id');
            if (!avatarId) continue;
            const nameBlock = card.querySelector(SEL.nameBlock);
            if (!nameBlock) continue;

            card.querySelectorAll('.pt-card-actions, .pt-card-tags').forEach(n => n.remove());

            const actions = el('span', { cls: 'pt-card-actions' },
                el('button', {
                    cls: 'pt-icon-btn', title: 'Folders', attrs: { type: 'button', 'data-pt-focus': `folders:${avatarId}` },
                    on: {
                        click: (e) => { e.stopPropagation(); e.preventDefault(); openPersonaFolders(e.currentTarget, avatarId); },
                        mousedown: (e) => e.stopPropagation(),
                    },
                }, icon('fa-folder')),
                el('button', {
                    cls: 'pt-icon-btn', title: 'Tags', attrs: { type: 'button', 'data-pt-focus': `tags:${avatarId}` },
                    on: {
                        click: (e) => { e.stopPropagation(); e.preventDefault(); openTagManager(e.currentTarget, avatarId); },
                        mousedown: (e) => e.stopPropagation(),
                    },
                }, icon('fa-tags')),
            );
            nameBlock.append(actions);

            const tags = getTagsOf(avatarId);
            if (tags.length) {
                const chips = el('div', { cls: 'pt-card-tags' });
                for (const tag of tags) {
                    const chip = el('button', {
                        cls: 'pt-tag-chip pt-tag-chip-small', text: tag.name,
                        title: 'Filter by this tag',
                        attrs: { type: 'button', 'aria-pressed': String(view.tags.includes(tag.id)), 'data-pt-focus': `card-tag:${avatarId}:${tag.id}` },
                        on: {
                            click: (e) => { e.stopPropagation(); toggleTagFilter(tag.id); },
                            mousedown: (e) => e.stopPropagation(),
                        },
                    });
                    styleTagChip(chip, tag.color);
                    chips.append(chip);
                }
                nameBlock.insertAdjacentElement('afterend', chips);
            }
        }
    }

    // --- Folder header (breadcrumb inside folder view) ---

    let folderHeader = null;

    function createFolderHeader() {
        const block = document.querySelector(SEL.block);
        if (!block || folderHeader) return;
        const backBtn = el('button', {
            cls: 'pt-back-btn menu_button', title: 'Back to all personas', attrs: { type: 'button' },
            on: { click: () => changeView(() => { view.folder = null; }) },
        }, icon('fa-arrow-left'));
        const title = el('div', { cls: 'pt-folder-header-title' });
        const editBtn = el('button', {
            cls: 'pt-icon-btn', title: 'Edit folder', attrs: { type: 'button' },
            on: { click: (e) => { if (view.folder) openFolderEditor(e.currentTarget, view.folder); } },
        }, icon('fa-pen'));
        folderHeader = el('div', { cls: 'pt-folder-header pt-hidden' }, backBtn, title, editBtn);
        block.parentNode.insertBefore(folderHeader, block);
    }

    function updateFolderHeader() {
        if (!folderHeader) return;
        const show = !!view.folder && !isSearchActive();
        folderHeader.classList.toggle('pt-hidden', !show);
        if (show) {
            const title = folderHeader.querySelector('.pt-folder-header-title');
            title.replaceChildren(
                icon('fa-folder-open'),
                el('span', { cls: 'pt-folder-header-name', text: view.folder }),
                el('span', { cls: 'pt-folder-count', text: String(getFolderMembers(view.folder).length) }),
            );
        }
    }

    // ============================================
    // TAG FILTER BAR
    // ============================================

    let tagBar = null;
    let tagToggleBtn = null;
    let tagBarExpanded = false;
    let tagSearchValue = '';

    function toggleTagFilter(tagId) {
        changeView(() => {
            if (view.tags.includes(tagId)) view.tags = view.tags.filter(t => t !== tagId);
            else view.tags.push(tagId);
        });
        if (view.tags.length) tagBarExpanded = true;
        renderTagBar();
    }

    function createTagBar() {
        const headerRow = document.querySelector(SEL.headerRow);
        if (!headerRow || tagBar) return;
        // The toggle lives inside ST's own header row (next to the search bar)
        // so the panel doesn't grow an extra control row; the chips expand below.
        tagToggleBtn = el('button', {
            cls: 'pt-tag-bar-toggle menu_button', title: 'Filter by tags',
            attrs: { type: 'button' },
            on: { click: () => { tagBarExpanded = !tagBarExpanded; renderTagBar(); } },
        });
        const searchBar = headerRow.querySelector('#persona_search_bar');
        if (searchBar) searchBar.insertAdjacentElement('afterend', tagToggleBtn);
        else headerRow.append(tagToggleBtn);
        tagBar = el('div', { cls: 'pt-tag-bar' });
        headerRow.insertAdjacentElement('afterend', tagBar);
        renderTagBar();
    }

    function renderTagBar() {
        if (!tagBar || !tagToggleBtn) return;
        const restoreFocus = rememberFocus(tagBar, { fallback: () => tagToggleBtn.focus({ preventScroll: true }) });

        const hasTags = settings.persona_tags.length > 0;
        const activeCount = view.tags.length;

        tagToggleBtn.classList.toggle('pt-hidden', !hasTags && !activeCount);
        tagToggleBtn.classList.toggle('pt-open', tagBarExpanded);
        tagToggleBtn.setAttribute('aria-expanded', String(tagBarExpanded));
        tagToggleBtn.setAttribute('aria-label', `Filter by tags${activeCount ? `, ${activeCount} active` : ''}`);
        const toggleKids = [icon('fa-tags'), el('span', { cls: 'pt-tag-toggle-label', text: 'Tags' })];
        if (activeCount) toggleKids.push(el('span', { cls: 'pt-tag-toggle-badge', text: String(activeCount) }));
        toggleKids.push(icon(`fa-chevron-${tagBarExpanded ? 'up' : 'down'} pt-chevron`));
        tagToggleBtn.replaceChildren(...toggleKids);

        tagBar.replaceChildren();
        if (!tagBarExpanded || (!hasTags && !activeCount)) { tagBar.classList.add('pt-hidden'); restoreFocus(); return; }
        tagBar.classList.remove('pt-hidden');

        const chips = el('div', { cls: 'pt-tag-bar-chips' });
        const renderChips = () => {
            chips.replaceChildren();
            const needle = tagSearchValue.trim().toLowerCase();
            for (const tag of [...settings.persona_tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
                if (needle && !tag.name.toLowerCase().includes(needle)) continue;
                const selected = view.tags.includes(tag.id);
                const chip = el('button', {
                    cls: `pt-tag-chip${selected ? ' pt-selected' : ''}`,
                    attrs: { type: 'button', 'aria-pressed': String(selected), 'data-pt-focus': `filter-tag:${tag.id}` },
                    on: { click: () => toggleTagFilter(tag.id) },
                }, el('span', { text: tag.name }), el('span', { cls: 'pt-tag-chip-count', text: String(getTagUsage(tag.id)) }));
                styleTagChip(chip, tag.color);
                chips.append(chip);
            }
            if (!chips.children.length) chips.append(el('div', { cls: 'pt-empty', text: needle ? 'No matching tags' : 'No tags yet' }));
        };

        const header = el('div', { cls: 'pt-tag-bar-header' });
        if (settings.persona_tags.length > 6 || tagSearchValue) {
            header.append(el('input', {
                cls: 'pt-input pt-tag-bar-search',
                attrs: { type: 'search', placeholder: 'Filter tags…', 'aria-label': 'Filter tags', value: tagSearchValue, 'data-pt-focus': 'tag-search' },
                on: { input: (e) => { tagSearchValue = e.target.value; renderChips(); } },
            }));
        }
        if (activeCount) {
            header.append(el('span', { cls: 'pt-tag-bar-active', text: `${activeCount} filter${activeCount > 1 ? 's' : ''} active` }));
            header.append(el('button', {
                cls: 'pt-clear-btn menu_button', attrs: { type: 'button' },
                on: { click: () => { changeView(() => { view.tags = []; }); renderTagBar(); } },
            }, icon('fa-xmark'), el('span', { text: 'Clear' })));
        }
        if (header.children.length) tagBar.append(header);

        renderChips();
        tagBar.append(chips);
        restoreFocus();
    }

    // ============================================
    // POPOVERS
    // ============================================

    let activePopover = null;

    function focusableControls(container) {
        if (!container) return [];
        return [...container.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
            .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length);
    }

    function focusPersonaPanel() {
        const panel = document.querySelector(SEL.panel);
        if (!panel || !panel.getClientRects().length) return;
        if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        panel.focus({ preventScroll: true });
    }

    /** Preserve the logical control when a render replaces its DOM node. */
    function rememberFocus(container, { fallback } = {}) {
        const focused = document.activeElement;
        if (!container || !focused || !container.contains(focused)) return () => {};
        const key = focused.getAttribute('data-pt-focus');
        const id = focused.id;
        const index = focusableControls(container).indexOf(focused);
        const selection = typeof focused.selectionStart === 'number'
            ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
        return () => {
            if (focused.isConnected && focused.getClientRects().length) return;
            // An unrelated control may have deliberately taken focus during an
            // asynchronous host render. Do not move the user back in that case.
            if (document.activeElement !== document.body && document.activeElement !== focused && document.activeElement?.isConnected) return;
            const controls = focusableControls(container);
            let target = controls.find(node => (key && node.getAttribute('data-pt-focus') === key) || (id && node.id === id));
            if (!target && fallback) { fallback(); return; }
            target ||= controls[Math.min(Math.max(index, 0), controls.length - 1)] || container.closest('.pt-popover');
            target?.focus({ preventScroll: true });
            if (selection && target === controls.find(node => node.getAttribute('data-pt-focus') === key)) {
                try { target.setSelectionRange(...selection); } catch { /* non-text input */ }
            }
        };
    }

    function closePopover({ restoreFocus = true } = {}) {
        if (!activePopover) return;
        const closing = activePopover;
        activePopover = null;
        closing.cleanup(restoreFocus);
    }

    /** Keep fixed overlays inside the visible viewport as content and anchors move. */
    function trackOverlayPosition(overlay, anchor, { preferAbove = false, centered = false } = {}) {
        let lastRect = anchor?.getBoundingClientRect();
        let frame = null;
        let disposed = false;
        const position = () => {
            frame = null;
            if (disposed || !overlay.isConnected) return;
            if (anchor?.isConnected && anchor.getClientRects().length) lastRect = anchor.getBoundingClientRect();
            const viewport = window.visualViewport;
            const leftEdge = (viewport?.offsetLeft || 0) + 8;
            const topEdge = (viewport?.offsetTop || 0) + 8;
            const width = viewport?.width || window.innerWidth;
            const height = viewport?.height || window.innerHeight;
            const rightEdge = leftEdge + width - 16;
            const bottomEdge = topEdge + height - 16;
            overlay.style.setProperty('--pt-viewport-width', `${width}px`);
            overlay.style.setProperty('--pt-viewport-height', `${height}px`);
            const rect = lastRect || { left: leftEdge, top: topEdge, bottom: topEdge, width: 0 };
            // offset sizes exclude the opening animation's scale/translation.
            const overlayWidth = overlay.offsetWidth;
            const overlayHeight = overlay.offsetHeight;
            let left = centered ? rect.left + rect.width / 2 - overlayWidth / 2 : rect.left;
            let top = preferAbove ? rect.top - overlayHeight - 8 : rect.bottom + 8;
            if (preferAbove ? top < topEdge : top + overlayHeight > bottomEdge) {
                top = preferAbove ? rect.bottom + 8 : rect.top - overlayHeight - 8;
            }
            left = Math.max(leftEdge, Math.min(left, rightEdge - overlayWidth));
            top = Math.max(topEdge, Math.min(top, bottomEdge - overlayHeight));
            overlay.style.left = `${left}px`;
            overlay.style.top = `${top}px`;
        };
        const schedule = () => {
            if (!disposed && frame === null) frame = requestAnimationFrame(position);
        };
        const observer = new ResizeObserver(schedule);
        observer.observe(overlay);
        if (anchor) observer.observe(anchor);
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        window.visualViewport?.addEventListener('resize', schedule);
        window.visualViewport?.addEventListener('scroll', schedule);
        position();
        return () => {
            disposed = true;
            if (frame !== null) cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener('resize', schedule);
            window.removeEventListener('scroll', schedule, true);
            window.visualViewport?.removeEventListener('resize', schedule);
            window.visualViewport?.removeEventListener('scroll', schedule);
        };
    }

    /**
     * Anchored popover with backdrop. Esc or backdrop click closes it.
     * Returns the body element for content.
     */
    function openPopover(anchor, titleText, titleIcon, { personaId = null, folderName = null } = {}) {
        closePopover({ restoreFocus: false });
        const anchorKey = anchor.getAttribute('data-pt-focus');
        // Swallow the backdrop's pointer events entirely: if the click bubbled
        // to document, ST would treat it as an outside click and close the
        // whole persona-management drawer along with the popover.
        const backdrop = el('div', {
            cls: 'pt-backdrop',
            on: {
                click: (e) => { e.stopPropagation(); e.preventDefault(); closePopover(); },
                mousedown: (e) => { e.stopPropagation(); e.preventDefault(); },
                mouseup: (e) => e.stopPropagation(),
                touchstart: (e) => e.stopPropagation(),
            },
        });
        const header = el('div', { cls: 'pt-popover-header' },
            icon(titleIcon),
            el('span', { cls: 'pt-popover-title', text: titleText }),
            el('button', { cls: 'pt-icon-btn', title: 'Close', attrs: { type: 'button' }, on: { click: () => closePopover() } }, icon('fa-xmark')),
        );
        const body = el('div', { cls: 'pt-popover-body' });
        const popover = el('div', {
            cls: 'pt-popover',
            attrs: { role: 'dialog', 'aria-label': titleText, 'aria-modal': 'true', tabindex: '-1' },
            on: {
                click: (e) => e.stopPropagation(),
                mousedown: (e) => e.stopPropagation(),
                touchstart: (e) => e.stopPropagation(),
                // Let local fields and native controls process keys, then stop
                // the host's chat shortcuts from handling the same event.
                keydown: (e) => e.stopPropagation(),
                keyup: (e) => e.stopPropagation(),
            },
        }, header, body);

        const onKeydown = (e) => {
            if (isComposingKey(e)) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); return; }
            if (e.key !== 'Tab') return;
            const controls = focusableControls(popover);
            const first = controls[0] || popover;
            const last = controls[controls.length - 1] || popover;
            if (!popover.contains(document.activeElement) || document.activeElement === popover
                || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            }
            e.stopPropagation();
        };
        document.addEventListener('keydown', onKeydown, true);
        document.body.append(backdrop, popover);
        const stopPositioning = trackOverlayPosition(popover, anchor, { centered: true });
        const positionFrame = requestAnimationFrame(() => {
            if (!popover.isConnected) return;
            popover.classList.add('pt-positioned');
            (focusableControls(body)[0] || focusableControls(popover)[0] || popover).focus({ preventScroll: true });
        });

        const session = {
            personaId,
            folderName,
            refresh: null,
            disposeContent: null,
            cleanup: (restoreFocus) => {
                cancelAnimationFrame(positionFrame);
                stopPositioning();
                document.removeEventListener('keydown', onKeydown, true);
                session.disposeContent?.();
                backdrop.remove();
                popover.remove();
                if (!restoreFocus) return;
                const replacement = anchorKey && [...document.querySelectorAll('[data-pt-focus]')]
                    .find(node => node.getAttribute('data-pt-focus') === anchorKey && node.getClientRects().length);
                const target = anchor.isConnected && anchor.getClientRects().length ? anchor : replacement;
                if (target) target.focus({ preventScroll: true });
                else focusPersonaPanel();
            },
        };
        activePopover = session;
        return body;
    }

    /** Share confirmation timing while callers own controls and event guards. */
    function createConfirmation(onConfirm, onArmedChange) {
        let armed = false;
        let timer = null;
        let disposed = false;
        const reset = () => {
            clearTimeout(timer);
            timer = null;
            if (armed) {
                armed = false;
                onArmedChange(false);
            }
        };
        return {
            activate() {
                if (disposed) return;
                if (armed) {
                    reset();
                    onConfirm();
                    return;
                }
                armed = true;
                onArmedChange(true);
                timer = setTimeout(reset, 3000);
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                reset();
            },
        };
    }

    // --- Bulk find and replace ---

    const replacementFields = { name: 'Name', title: 'Title', description: 'Description' };

    function readPersonaText(id, field) {
        const value = field === 'name' ? powerUser.personas[id] : powerUser.persona_descriptions?.[id]?.[field];
        return typeof value === 'string' ? value : '';
    }

    function replacementSnapshotIsCurrent(snapshot) {
        return snapshot.every(({ id, fields }) => personaExists(id)
            && Object.entries(fields).every(([field, before]) => readPersonaText(id, field) === before));
    }

    function createFindReplaceButton() {
        const header = document.querySelector(SEL.headerRow);
        if (!header || header.querySelector('.pt-find-replace')) return;
        const button = el('button', {
            cls: 'pt-find-replace menu_button', title: 'Find and replace',
            attrs: { type: 'button', 'data-pt-focus': 'find-replace', 'aria-haspopup': 'dialog', 'aria-label': 'Find and replace' },
            on: { click: () => openFindReplace(button) },
        }, icon('fa-magnifying-glass'), el('span', { text: 'Find and replace' }));
        header.append(button);
    }

    function openFindReplace(anchor) {
        closeQuickMenu({ restoreFocus: false });
        const body = openPopover(anchor, 'Find and replace', 'fa-magnifying-glass');
        body.closest('.pt-popover').classList.add('pt-replace-dialog');
        const session = activePopover;
        const selected = new Set();
        let preview = null;
        let stopPreview = null;
        let applying = false;
        let generation = 0;
        const controls = el('fieldset', { cls: 'pt-replace-controls' });
        const search = el('input', { cls: 'pt-input text_pole', attrs: { type: 'search', 'aria-label': 'Search personas', placeholder: 'Search personas…' } });
        const count = el('span', { cls: 'pt-replace-count', text: '0 selected', attrs: { 'aria-live': 'polite' } });
        const picker = el('div', { cls: 'pt-popover-list pt-replace-picker', attrs: { 'aria-label': 'Personas' } });
        const status = el('div', { cls: 'pt-replace-status', attrs: { role: 'status' } });
        const feedback = el('div', { cls: 'pt-replace-error', attrs: { role: 'alert' } });
        feedback.hidden = true;
        const results = el('div', { cls: 'pt-replace-preview' });
        const fieldInputs = {};
        const fields = el('fieldset', { cls: 'pt-replace-fields' }, el('legend', { text: 'Search in' }));
        for (const [field, label] of Object.entries(replacementFields)) {
            const input = el('input', { attrs: { type: 'checkbox' }, on: { change: () => invalidate() } });
            input.checked = true;
            fieldInputs[field] = input;
            fields.append(el('label', { cls: 'pt-check-row' }, input, el('span', { text: label })));
        }
        const find = el('textarea', { cls: 'pt-input text_pole', attrs: { rows: '2', 'aria-label': 'Find', spellcheck: 'false' }, on: { input: () => invalidate() } });
        const replacement = el('textarea', { cls: 'pt-input text_pole', attrs: { rows: '2', 'aria-label': 'Replace with', spellcheck: 'false' }, on: { input: () => invalidate() } });
        const matchCase = el('input', { attrs: { type: 'checkbox' }, on: { change: () => invalidate() } });
        matchCase.checked = true;
        const useRegex = el('input', { attrs: { type: 'checkbox' }, on: { change: () => { help.hidden = !useRegex.checked; invalidate(); } } });
        const help = el('div', { cls: 'pt-replace-help', text: 'Enter a JavaScript pattern without / delimiters. All matches are replaced. Use $1 or $<name> for captures, $& for the match, and $$ for a literal $. Match case controls case sensitivity.' });
        help.hidden = true;
        const previewButton = el('button', { cls: 'menu_button', text: 'Preview changes', attrs: { type: 'button' }, on: { click: calculatePreview } });
        const applyButton = el('button', { cls: 'menu_button pt-primary-btn', text: 'Apply replacements', attrs: { type: 'button' }, on: { click: applyPreview } });
        applyButton.disabled = true;

        function showError(message = '') {
            feedback.textContent = message;
            feedback.hidden = !message;
        }

        function invalidate(message = '') {
            generation++;
            stopPreview?.();
            stopPreview = null;
            preview = null;
            applyButton.disabled = true;
            previewButton.disabled = false;
            results.replaceChildren();
            status.textContent = '';
            showError(message);
        }

        function matchingPersonas() {
            const needle = search.value.trim().toLowerCase();
            return Object.keys(powerUser.personas || {}).filter(id =>
                !needle || [getPersonaName(id), getPersonaTitle(id), id].some(value => value.toLowerCase().includes(needle)))
                .sort((a, b) => getPersonaName(a).localeCompare(getPersonaName(b)) || a.localeCompare(b));
        }

        function renderPicker() {
            let removed = false;
            for (const id of selected) if (!personaExists(id)) { selected.delete(id); removed = true; }
            if (removed) invalidate('Persona data changed. Preview again before applying.');
            const restoreFocus = rememberFocus(picker);
            picker.replaceChildren();
            for (const id of matchingPersonas()) {
                const name = getPersonaName(id);
                const input = el('input', {
                    attrs: { type: 'checkbox', 'aria-label': `Select ${name} (${id})`, 'data-pt-focus': `replace-persona:${id}` },
                    on: { change: () => {
                        if (input.checked) selected.add(id); else selected.delete(id);
                        count.textContent = `${selected.size} selected`;
                        invalidate();
                    } },
                });
                input.checked = selected.has(id);
                const text = el('span', { cls: 'pt-replace-persona-text' },
                    el('span', { text: name }),
                    el('small', { text: [getPersonaTitle(id), id].filter(Boolean).join(' · ') }));
                picker.append(el('label', { cls: 'pt-check-row' }, input,
                    el('img', { cls: 'pt-member-thumb', attrs: { src: thumbUrl(id), alt: '', loading: 'lazy' } }), text));
            }
            if (!picker.children.length) picker.append(el('div', { cls: 'pt-empty', text: 'No matching personas' }));
            count.textContent = `${selected.size} selected`;
            restoreFocus();
        }

        function renderPreview(result) {
            status.textContent = `${result.matchCount} matches; ${result.personaCount} personas and ${result.fieldCount} fields would change.`;
            for (const change of result.changes) {
                const details = el('details', {}, el('summary', { text: `${change.name} (${change.id})` }));
                for (const field of change.fields) {
                    details.append(el('div', { cls: 'pt-replace-field-preview', attrs: { 'data-field': field.field } },
                        el('strong', { text: `${replacementFields[field.field]} — ${field.matches} matches` }),
                        el('span', { text: 'Before' }), el('pre', { text: field.before, attrs: { 'data-version': 'before' } }),
                        el('span', { text: 'After' }), el('pre', { text: field.after, attrs: { 'data-version': 'after' } })));
                }
                results.append(details);
            }
            if (result.invalidNames.length) {
                showError(`Replacement would leave a blank persona name: ${result.invalidNames.map(item => `${item.name} (${item.id})`).join(', ')}. Change the replacement or exclude Name.`);
            } else applyButton.disabled = result.changes.length === 0;
        }

        function calculatePreview() {
            if (!body.isConnected || applying) return;
            invalidate();
            const chosenFields = Object.keys(fieldInputs).filter(field => fieldInputs[field].checked);
            if (!selected.size) { showError('Select at least one persona.'); return; }
            if (!chosenFields.length) { showError('Select at least one text field.'); return; }
            if (!find.value.length) { showError('Enter text or a pattern to find.'); return; }
            const snapshot = [...selected].map(id => ({ id, name: getPersonaName(id), fields: Object.fromEntries(chosenFields.map(field => [field, readPersonaText(id, field)])) }));
            if (!replacementSnapshotIsCurrent(snapshot)) { showError('Persona data changed. Select personas and preview again.'); return; }
            const request = generation;
            let worker;
            let timer;
            const finish = () => {
                clearTimeout(timer);
                worker?.terminate();
                stopPreview = null;
                previewButton.disabled = false;
            };
            try {
                worker = new Worker(new URL('./find-replace-worker.js', import.meta.url), { type: 'module' });
                stopPreview = () => { clearTimeout(timer); worker.terminate(); };
                status.textContent = 'Calculating preview…';
                previewButton.disabled = true;
                worker.onmessage = ({ data }) => {
                    if (!body.isConnected || generation !== request) return;
                    finish();
                    status.textContent = '';
                    if (data.error) { showError(data.error); return; }
                    if (!replacementSnapshotIsCurrent(snapshot)) { invalidate('Persona data changed. Preview again before applying.'); return; }
                    preview = { snapshot, result: data };
                    renderPreview(data);
                };
                worker.onerror = (event) => {
                    event.preventDefault();
                    if (!body.isConnected || generation !== request) return;
                    finish();
                    status.textContent = '';
                    showError('Could not calculate replacements. Please try again.');
                };
                timer = setTimeout(() => {
                    if (!body.isConnected || generation !== request) return;
                    finish();
                    status.textContent = '';
                    showError('Matching took longer than two seconds. Simplify the pattern or select fewer personas, then preview again.');
                }, 2000);
                worker.postMessage({ personas: snapshot, find: find.value, replacement: replacement.value, matchCase: matchCase.checked, useRegex: useRegex.checked });
            } catch (e) {
                finish();
                status.textContent = '';
                showError('Could not start matching. Please try again.');
                error('Replacement worker failed', e);
            }
        }

        async function applyPreview() {
            if (!body.isConnected || applying || !preview || applyButton.disabled) return;
            const ready = preview;
            applying = true;
            controls.disabled = true;
            let committed = false;
            try {
                // Resolve the native setter before any write; loading a module can yield.
                const { setUserName } = await import('/script.js');
                if (!body.isConnected) return;
                if (!replacementSnapshotIsCurrent(ready.snapshot)) {
                    invalidate('Persona data changed. Preview again before applying.');
                    renderPicker();
                    return;
                }
                const activeId = getCurrentAvatar();
                const activeChange = ready.result.changes.find(change => change.id === activeId);
                if (activeChange?.fields.some(field => field.field === 'name') && typeof setUserName !== 'function') {
                    throw new Error('Native persona name setter is unavailable');
                }
                // Complete all field writes synchronously before notifying listeners.
                for (const change of ready.result.changes) {
                    for (const { field, after } of change.fields) {
                        if (field === 'name') powerUser.personas[change.id] = after;
                        else {
                            powerUser.persona_descriptions ||= {};
                            powerUser.persona_descriptions[change.id] ||= {};
                            powerUser.persona_descriptions[change.id][field] = after;
                        }
                        if (change.id === activeId && field === 'description') powerUser.persona_description = after;
                    }
                }
                committed = true;
                invalidate(); // This preview can never be applied a second time.
                saveSettings();
                let notificationFailed = false;
                try {
                    if (activeChange?.fields.some(field => field.field === 'name')) setUserName(powerUser.personas[activeId], { toastPersonaNameChange: false });
                    if (activeChange) personasApi.setPersonaDescription();
                } catch (e) { notificationFailed = true; error('Active persona refresh failed', e); }
                for (const change of ready.result.changes) {
                    const name = change.fields.find(field => field.field === 'name');
                    const events = [];
                    if (name && event_types.PERSONA_RENAMED) events.push([event_types.PERSONA_RENAMED, { avatarId: change.id, oldName: name.before, newName: name.after }]);
                    if (event_types.PERSONA_UPDATED) events.push([event_types.PERSONA_UPDATED, change.id]);
                    for (const [type, payload] of events) {
                        try { await eventSource.emit(type, payload); }
                        catch (e) { notificationFailed = true; error('Persona update listener failed', e); }
                    }
                }
                await refreshList();
                if (!body.isConnected) return;
                renderPicker();
                status.textContent = `Applied replacements to ${ready.result.personaCount} personas and ${ready.result.fieldCount} fields.`;
                if (notificationFailed) showError('Replacements were applied, but a persona update listener failed. Reload to refresh the display.');
                else if (listError && !listError.hidden) showError('Replacements were applied. Close this dialog and use Retry to reload the persona list.');
            } catch (e) {
                error('Could not apply replacements', e);
                if (body.isConnected) showError(committed ? 'Replacements were applied, but the display could not refresh. Reload to refresh it.' : 'Could not apply replacements. No persona text was changed. Please try again.');
            } finally {
                applying = false;
                controls.disabled = false;
            }
        }

        search.addEventListener('input', renderPicker);
        controls.append(
            el('div', { cls: 'pt-popover-section-title', text: 'Choose personas' }), search,
            el('div', { cls: 'pt-replace-selection-actions' },
                el('button', { cls: 'menu_button', text: 'Select all results', attrs: { type: 'button' }, on: { click: () => { matchingPersonas().forEach(id => selected.add(id)); invalidate(); renderPicker(); } } }),
                el('button', { cls: 'menu_button', text: 'Clear selection', attrs: { type: 'button' }, on: { click: () => { selected.clear(); invalidate(); renderPicker(); } } }), count),
            picker, fields,
            el('label', { cls: 'pt-replace-text-label' }, el('span', { text: 'Find' }), find),
            el('label', { cls: 'pt-replace-text-label' }, el('span', { text: 'Replace with' }), replacement),
            el('div', { cls: 'pt-replace-options' },
                el('label', { cls: 'pt-check-row' }, matchCase, el('span', { text: 'Match case' })),
                el('label', { cls: 'pt-check-row' }, useRegex, el('span', { text: 'Use regular expression' }))),
            help, feedback, status, results,
            el('div', { cls: 'pt-popover-footer' }, previewButton, applyButton));
        body.append(controls);
        session.refreshPersonas = () => {
            if (applying) return;
            let removed = false;
            for (const id of selected) if (!personaExists(id)) { selected.delete(id); removed = true; }
            if (removed || (preview && !replacementSnapshotIsCurrent(preview.snapshot))) invalidate('Persona data changed. Preview again before applying.');
            renderPicker();
        };
        session.disposeContent = () => { generation++; stopPreview?.(); };
        renderPicker();
    }

    // --- Popover: folders of one persona ---

    function openPersonaFolders(anchor, avatarId) {
        if (!personaExists(avatarId)) return;
        const body = openPopover(anchor, `Folders — ${getPersonaName(avatarId)}`, 'fa-folder-tree', { personaId: avatarId });
        const list = el('div', { cls: 'pt-popover-list' });
        // Undo belongs to this dialog. A fresh Create never inherits it.
        const removedFolders = new Map();

        // Includes folders that exist only in settings (still assembling).
        function getAllFolderNames() {
            const names = new Set(removedFolders.keys());
            for (const folders of Object.values(settings.personaGroups)) folders.forEach(f => names.add(f));
            return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        }

        function render() {
            const restoreFocus = rememberFocus(list);
            list.replaceChildren();
            const memberOf = getFoldersOf(avatarId);
            const folders = getAllFolderNames();
            if (!folders.length) {
                list.append(el('div', { cls: 'pt-empty', text: 'No folders yet — create one below' }));
                restoreFocus();
                return;
            }
            for (const name of folders) {
                const checkbox = el('input', { attrs: { type: 'checkbox', 'aria-label': name, 'data-pt-focus': `membership:${name}` } });
                checkbox.checked = memberOf.includes(name);
                checkbox.addEventListener('change', () => {
                    if (!body.isConnected || !personaExists(avatarId)) return;
                    let changed = false;
                    if (checkbox.checked) {
                        if (removedFolders.has(name) && !folderStillReferenced(name)) {
                            changed = setFolderDescription(name, removedFolders.get(name));
                        }
                        removedFolders.delete(name);
                        changed = addToFolder(avatarId, name) || changed;
                    } else {
                        const description = getFolderDescription(name);
                        changed = removeFromFolder(avatarId, name);
                        if (!folderStillReferenced(name)) removedFolders.set(name, description);
                    }
                    if (changed) saveSettings();
                    render();
                    refreshListSoon();
                });
                list.append(el('label', { cls: 'pt-check-row' },
                    checkbox,
                    el('span', { cls: 'pt-check-row-name', text: name }),
                    el('span', { cls: 'pt-check-row-count', text: String(getFolderMembers(name).length) }),
                ));
            }
            restoreFocus();
        }

        const nameInput = el('input', { cls: 'pt-input', attrs: { type: 'text', placeholder: 'New folder name', 'aria-label': 'New folder name', 'aria-describedby': 'pt-new-folder-error' } });
        const descInput = el('input', { cls: 'pt-input', attrs: { type: 'text', placeholder: 'Description (optional)', 'aria-label': 'Folder description' } });
        const duplicateError = el('div', { cls: 'pt-form-error pt-hidden', attrs: { id: 'pt-new-folder-error', role: 'status' } });
        nameInput.addEventListener('input', () => {
            nameInput.removeAttribute('aria-invalid');
            duplicateError.classList.add('pt-hidden');
            duplicateError.textContent = '';
        });
        const addBtn = el('button', {
            cls: 'pt-primary-btn menu_button', attrs: { type: 'button' },
            on: {
                click: () => {
                    if (!body.isConnected || !personaExists(avatarId)) return;
                    const name = nameInput.value.trim();
                    if (!name) { nameInput.focus(); return; }
                    if (folderStillReferenced(name)) {
                        duplicateError.textContent = 'This folder already exists. Use its checkbox to assign it, or Edit folder to change its description.';
                        duplicateError.classList.remove('pt-hidden');
                        nameInput.setAttribute('aria-invalid', 'true');
                        nameInput.focus();
                        return;
                    }
                    const desc = descInput.value.trim();
                    removedFolders.delete(name);
                    const descriptionChanged = setFolderDescription(name, desc);
                    const membershipChanged = addToFolder(avatarId, name);
                    if (descriptionChanged || membershipChanged) saveSettings();
                    nameInput.removeAttribute('aria-invalid');
                    duplicateError.classList.add('pt-hidden');
                    duplicateError.textContent = '';
                    nameInput.value = ''; descInput.value = '';
                    render();
                    refreshListSoon();
                },
            },
        }, icon('fa-plus'), el('span', { text: 'Create' }));
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isComposingKey(e)) { e.preventDefault(); e.stopPropagation(); addBtn.click(); } });

        body.append(
            list,
            el('div', { cls: 'pt-popover-section-title', text: 'New folder' }),
            el('div', { cls: 'pt-form-row' }, nameInput, addBtn),
            duplicateError,
            descInput,
        );
        render();
    }

    // --- Popover: edit one folder ---

    /** Reconcile folder lifetimes after an editor or native persona mutation. */
    function reconcileFolderUi(affectedFolders) {
        const editedFolder = activePopover?.folderName;
        if (editedFolder && affectedFolders.has(editedFolder)) {
            if (getFolderMembers(editedFolder).length) activePopover.refresh?.();
            else closePopover();
        }
        if (view.folder && !getFolderMembers(view.folder).length) {
            changeView(() => { view.folder = null; });
            return true;
        }
        return false;
    }

    function openFolderEditor(anchor, folderName) {
        if (!getFolderMembers(folderName).length) return;
        const body = openPopover(anchor, `Edit folder — ${folderName}`, 'fa-folder-open', { folderName });
        const popover = activePopover;

        const nameInput = el('input', { cls: 'pt-input', attrs: { type: 'text', 'aria-label': 'Folder name' } });
        nameInput.value = folderName;
        const descInput = el('input', { cls: 'pt-input', attrs: { type: 'text', placeholder: 'Description (optional)', 'aria-label': 'Folder description' } });
        descInput.value = getFolderDescription(folderName);

        const list = el('div', { cls: 'pt-popover-list' });
        function renderMembers() {
            const restoreFocus = rememberFocus(list);
            list.replaceChildren();
            const members = getFolderMembers(folderName);
            for (const avatarId of members) {
                list.append(el('div', { cls: 'pt-member-row' },
                    el('img', { cls: 'pt-member-thumb', attrs: { src: thumbUrl(avatarId), alt: '', loading: 'lazy' } }),
                    el('span', { cls: 'pt-member-name', text: getPersonaName(avatarId) }),
                    el('button', {
                        cls: 'pt-icon-btn', title: 'Remove from folder', attrs: { type: 'button', 'aria-label': `Remove ${getPersonaName(avatarId)} from folder`, 'data-pt-focus': `remove-member:${avatarId}` },
                        on: {
                            click: () => {
                                if (!body.isConnected) return;
                                if (removeFromFolder(avatarId, folderName)) saveSettings();
                                if (!reconcileFolderUi(new Set([folderName]))) refreshListSoon();
                            },
                        },
                    }, icon('fa-xmark')),
                ));
            }
            restoreFocus();
        }

        const initialDesc = getFolderDescription(folderName);
        const saveBtn = el('button', {
            cls: 'pt-primary-btn menu_button', attrs: { type: 'button' },
            on: {
                click: () => {
                    if (!body.isConnected) return;
                    if (!getFolderMembers(folderName).length) {
                        if (!reconcileFolderUi(new Set([folderName]))) refreshListSoon();
                        return;
                    }
                    const newName = nameInput.value.trim() || folderName;
                    const typedDesc = descInput.value.trim();
                    // Rename first, then write the description under the FINAL name
                    // (v1 wrote the new description before renaming, then clobbered
                    // it with the old one while moving keys). Only write when the
                    // user actually edited the field, so merging into an existing
                    // folder doesn't overwrite that folder's description with
                    // this one's untouched prefill.
                    const renamed = renameFolder(folderName, newName);
                    const descriptionChanged = typedDesc !== initialDesc && setFolderDescription(newName, typedDesc);
                    if (view.folder === folderName) view.folder = newName;
                    if (renamed || descriptionChanged) saveSettings();
                    closePopover();
                    refreshList();
                },
            },
        }, icon('fa-check'), el('span', { text: 'Save' }));

        const deleteLabel = el('span', { text: 'Delete folder' });
        const deleteBtn = el('button', {
            cls: 'pt-danger-btn menu_button', attrs: { type: 'button' },
            on: { click: () => { if (body.isConnected) confirmation.activate(); } },
        }, icon('fa-trash-can'), deleteLabel);
        const confirmation = createConfirmation(() => {
            closePopover();
            changeView(() => {
                if (deleteFolder(folderName)) saveSettings();
                if (view.folder === folderName) view.folder = null;
            });
        }, (armed) => {
            deleteBtn.classList.toggle('pt-armed', armed);
            deleteLabel.textContent = armed ? 'Really delete?' : 'Delete folder';
        });

        body.append(
            el('div', { cls: 'pt-popover-section-title', text: 'Name' }),
            nameInput,
            el('div', { cls: 'pt-popover-section-title', text: 'Description' }),
            descInput,
            el('div', { cls: 'pt-popover-section-title', text: 'Personas' }),
            list,
            el('div', { cls: 'pt-popover-footer' }, deleteBtn, saveBtn),
        );
        popover.refresh = renderMembers;
        popover.disposeContent = confirmation.dispose;
        renderMembers();
    }

    // --- Popover: tags of one persona ---

    function openTagManager(anchor, avatarId) {
        if (!personaExists(avatarId)) return;
        const body = openPopover(anchor, `Tags — ${getPersonaName(avatarId)}`, 'fa-tags', { personaId: avatarId });

        const assigned = el('div', { cls: 'pt-chip-group' });
        const available = el('div', { cls: 'pt-chip-group' });
        const confirmations = [];

        function disposeConfirmations() {
            for (const confirmation of confirmations.splice(0)) confirmation.dispose();
        }
        activePopover.disposeContent = disposeConfirmations;

        function toggleAssignment(tagId) {
            if (!body.isConnected || !personaExists(avatarId)) return;
            if (!toggleTagOn(avatarId, tagId)) return;
            saveSettings();
            render();
            refreshAfterTagChange(tagId);
        }

        function render() {
            const restoreFocus = rememberFocus(body);
            disposeConfirmations();
            assigned.replaceChildren();
            const tags = getTagsOf(avatarId);
            if (!tags.length) assigned.append(el('div', { cls: 'pt-empty', text: 'No tags assigned' }));
            for (const tag of tags) {
                const chip = el('button', {
                    cls: 'pt-tag-chip', title: 'Remove from persona', attrs: { type: 'button', 'aria-label': `Remove ${tag.name} from persona`, 'data-pt-focus': `assigned-tag:${tag.id}` },
                    on: { click: () => toggleAssignment(tag.id) },
                }, el('span', { text: tag.name }), icon('fa-xmark'));
                styleTagChip(chip, tag.color);
                assigned.append(chip);
            }

            available.replaceChildren();
            if (!settings.persona_tags.length) available.append(el('div', { cls: 'pt-empty', text: 'No tags yet — create one below' }));
            for (const tag of [...settings.persona_tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
                const isAssigned = (settings.persona_tag_map[avatarId] || []).includes(tag.id);
                const group = el('span', { cls: 'pt-tag-control' });
                styleTagChip(group, tag.color);
                const chip = el('button', {
                    cls: `pt-tag-chip${isAssigned ? ' pt-selected' : ''}`,
                    attrs: { type: 'button', 'aria-label': tag.name, 'aria-pressed': String(isAssigned), 'data-pt-focus': `available-tag:${tag.id}` },
                    on: { click: () => toggleAssignment(tag.id) },
                }, el('span', { text: tag.name }), el('span', { cls: 'pt-tag-chip-count', text: String(getTagUsage(tag.id)) }));
                styleTagChip(chip, tag.color);
                const del = el('button', {
                    cls: 'pt-chip-delete', title: 'Delete tag everywhere', attrs: { type: 'button', 'aria-label': `Delete ${tag.name} everywhere`, 'data-pt-focus': `delete-tag:${tag.id}` },
                    on: {
                        click: (e) => {
                            e.stopPropagation();
                            if (!body.isConnected || !personaExists(avatarId)) return;
                            confirmation.activate();
                        },
                    },
                }, icon('fa-trash-can'));
                const confirmation = createConfirmation(() => {
                    const wasFiltering = view.tags.includes(tag.id);
                    if (deleteTag(tag.id)) saveSettings();
                    view.tags = view.tags.filter(id => id !== tag.id);
                    render(); scheduleDecorate(); renderTagBar();
                    if (wasFiltering) refreshListSoon();
                }, armed => {
                    del.classList.toggle('pt-armed', armed);
                    del.setAttribute('aria-label', `${armed ? 'Confirm delete' : 'Delete'} ${tag.name} everywhere`);
                });
                confirmations.push(confirmation);
                del.style.color = contrastColor(tag.color);
                group.append(chip, del);
                available.append(group);
            }
            restoreFocus();
        }

        const nameInput = el('input', { cls: 'pt-input', attrs: { type: 'text', placeholder: 'New tag name', 'aria-label': 'New tag name' } });
        const colorInput = el('input', { cls: 'pt-color-input', attrs: { type: 'color', 'aria-label': 'Tag color' } });
        colorInput.value = randomTagColor();
        const shuffleBtn = el('button', {
            cls: 'pt-icon-btn', title: 'Random color', attrs: { type: 'button' },
            on: { click: () => { colorInput.value = randomTagColor(); } },
        }, icon('fa-shuffle'));
        const lightDarkBtn = el('button', {
            cls: 'pt-icon-btn', title: 'Toggle light/dark palette', attrs: { type: 'button' },
            on: {
                click: (e) => {
                    lightColors = !lightColors;
                    e.currentTarget.replaceChildren(icon(lightColors ? 'fa-sun' : 'fa-moon'));
                    colorInput.value = randomTagColor();
                },
            },
        }, icon(lightColors ? 'fa-sun' : 'fa-moon'));
        const addBtn = el('button', {
            cls: 'pt-primary-btn menu_button', attrs: { type: 'button' },
            on: {
                click: () => {
                    const name = nameInput.value.trim();
                    if (!name) { nameInput.focus(); return; }
                    if (!body.isConnected || !personaExists(avatarId)) return;
                    const tag = createTag(name, colorInput.value);
                    toggleTagOn(avatarId, tag.id);
                    saveSettings();
                    nameInput.value = '';
                    colorInput.value = randomTagColor();
                    render();
                    scheduleDecorate();
                    renderTagBar();
                },
            },
        }, icon('fa-plus'), el('span', { text: 'Add' }));
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isComposingKey(e)) { e.preventDefault(); e.stopPropagation(); addBtn.click(); } });

        body.append(
            el('div', { cls: 'pt-popover-section-title', text: 'Assigned' }),
            assigned,
            el('div', { cls: 'pt-popover-section-title', text: 'All tags' }),
            available,
            el('div', { cls: 'pt-popover-section-title', text: 'New tag' }),
            el('div', { cls: 'pt-form-row' }, nameInput, colorInput, shuffleBtn, lightDarkBtn, addBtn),
        );
        render();
    }

    // ============================================
    // TOOLTIP
    // ============================================

    let tooltip = null;
    let tooltipTimer = null;

    function showTooltip(target, name, title) {
        if (!tooltip) {
            tooltip = el('div', { cls: 'pt-tooltip' }, el('div', { cls: 'pt-tooltip-name' }), el('div', { cls: 'pt-tooltip-title' }));
            document.body.append(tooltip);
        }
        tooltip.querySelector('.pt-tooltip-name').textContent = name;
        const titleNode = tooltip.querySelector('.pt-tooltip-title');
        titleNode.textContent = title || '';
        titleNode.classList.toggle('pt-hidden', !title);

        clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(() => {
            if (!target.isConnected) return;
            const rect = target.getBoundingClientRect();
            tooltip.classList.add('pt-visible');
            const tr = tooltip.getBoundingClientRect();
            let left = rect.right + 10;
            let top = rect.top + rect.height / 2 - tr.height / 2;
            if (left + tr.width > window.innerWidth - 8) left = rect.left - tr.width - 10;
            top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        }, 350);
    }

    function hideTooltip() {
        clearTimeout(tooltipTimer);
        if (tooltip) tooltip.classList.remove('pt-visible');
    }

    // ============================================
    // QUICK PERSONA SWITCHER
    // ============================================

    let quickMenu = null;
    let quickMenuState = 'closed';
    let quickMenuRequest = 0;
    let quickMenuKeyHandler = null;
    let stopQuickMenuPositioning = null;

    function setQuickStatus(message = '') {
        const status = document.getElementById('pt-quick-status');
        if (status) status.textContent = message;
    }

    function isQuickMenuTarget(target) {
        return !!target?.closest?.('#quickPersonaMenu, #quickPersona');
    }

    function handleQuickMenuKeydown(e) {
        if (quickMenuState === 'closed' || !isQuickMenuTarget(e.target)) return;
        if (isComposingKey(e)) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeQuickMenu({ restoreFocus: true });
            return;
        }
        quickMenuKeyHandler?.(e);
    }

    function dismissQuickMenuOutside(e) {
        if (quickMenuState !== 'closed' && !isQuickMenuTarget(e.target)) closeQuickMenu();
    }

    function addQuickButton() {
        if (document.getElementById('quickPersona')) return;
        const img = el('img', { cls: 'pt-quick-img', attrs: { id: 'quickPersonaImg', src: '/img/ai4.png', alt: 'Persona' } });
        const caret = el('div', { cls: 'pt-quick-caret fa-solid fa-caret-up fa-fw', attrs: { id: 'quickPersonaCaret' } });
        const btn = el('div', {
            cls: 'interactable pt-quick-btn',
            attrs: { id: 'quickPersona', tabindex: '0', role: 'button', 'aria-label': 'Switch persona', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'quickPersonaMenu' },
            on: {
                click: () => toggleQuickMenu(),
                // stopPropagation: ST's global keyboard handler would synthesize a
                // second click on this .interactable div, toggling the menu twice.
                keydown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault(); e.stopPropagation();
                        if (!e.repeat && !isComposingKey(e)) toggleQuickMenu();
                    }
                },
                mouseenter: () => {
                    const cur = getCurrentAvatar();
                    if (cur && quickMenuState === 'closed') showTooltip(btn, getPersonaName(cur), getPersonaTitle(cur));
                },
                mouseleave: hideTooltip,
            },
        }, img, caret);
        const form = document.getElementById('leftSendForm');
        if (form) form.append(btn, el('span', {
            cls: 'pt-quick-status',
            attrs: { id: 'pt-quick-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
        }));
    }

    function updateQuickButton(force = false) {
        const img = document.getElementById('quickPersonaImg');
        if (!img) return;
        const cur = getCurrentAvatar();
        if (!cur) return;
        const src = thumbUrl(cur);
        if (force === true) {
            // Re-read the (server-refreshed) HTTP cache entry after an image change.
            img.removeAttribute('src');
            img.setAttribute('src', src);
        } else if (img.getAttribute('src') !== src) {
            img.setAttribute('src', src);
        }
        const title = getPersonaTitle(cur);
        img.title = title ? `${getPersonaName(cur)} — ${title}` : getPersonaName(cur);
    }

    async function toggleQuickMenu() {
        if (quickMenuState !== 'closed') { closeQuickMenu(); return; }
        await openQuickMenu();
    }

    function closeQuickMenu({ restoreFocus = false } = {}) {
        if (quickMenuState === 'closed') return;
        quickMenuRequest++;
        quickMenuState = 'closed';
        const menu = quickMenu;
        quickMenu = null;
        quickMenuKeyHandler = null;
        stopQuickMenuPositioning?.();
        stopQuickMenuPositioning = null;
        setQuickStatus();
        const trigger = document.getElementById('quickPersona');
        trigger?.setAttribute('aria-expanded', 'false');
        trigger?.removeAttribute('aria-busy');
        document.getElementById('quickPersonaCaret')?.classList.replace('fa-caret-down', 'fa-caret-up');
        hideTooltip();
        if (menu) {
            // The fading menu must not retain focus, accept activation, or share
            // an ID with a new menu opened before this transition finishes.
            menu.removeAttribute('id');
            menu.setAttribute('aria-hidden', 'true');
            menu.inert = true;
            menu.classList.remove('pt-open');
            setTimeout(() => menu.remove(), 180);
        }
        if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    }

    async function openQuickMenu() {
        if (!personasApi || quickMenuState !== 'closed') return;
        const request = ++quickMenuRequest;
        quickMenuState = 'opening';
        document.getElementById('quickPersona')?.setAttribute('aria-busy', 'true');
        setQuickStatus('Loading personas…');
        hideTooltip(); // cancel the quick button's pending hover tooltip
        let avatars = [];
        try {
            avatars = await personasApi.getUserAvatars(false);
            if (request !== quickMenuRequest || quickMenuState !== 'opening') return;
            if (!Array.isArray(avatars)) throw new Error('Avatar request did not return a persona list');
        }
        catch (e) {
            if (request !== quickMenuRequest) return;
            closeQuickMenu();
            setQuickStatus('Could not load personas. Activate Switch persona to retry.');
            error('failed to fetch avatars', e);
            return;
        }
        if (request !== quickMenuRequest || quickMenuState !== 'opening') return;

        const current = getCurrentAvatar();
        const menu = el('div', { cls: 'pt-quick-menu', attrs: { id: 'quickPersonaMenu', role: 'menu', tabindex: '-1', 'aria-label': 'Personas' } });
        const list = el('div', { cls: 'pt-quick-list' });
        const emptyState = el('div', {
            cls: `pt-empty${avatars.length ? ' pt-hidden' : ''}`,
            text: 'No personas available',
            attrs: { role: 'status' },
        });
        const rows = []; // flat list of rows for keyboard nav
        const parentFolders = new WeakMap();
        let activeIdx = -1;
        let activeOwner = menu;

        function addRow(row) {
            row.id = `pt-quick-row-${request}-${rows.length}`;
            rows.push(row);
            list.append(row);
        }

        function setActive(idx) {
            if (rows[activeIdx]) rows[activeIdx].classList.remove('pt-active');
            activeIdx = idx;
            if (rows[activeIdx]) {
                rows[activeIdx].classList.add('pt-active');
                activeOwner.setAttribute('aria-activedescendant', rows[activeIdx].id);
                menu.setAttribute('aria-activedescendant', rows[activeIdx].id);
                rows[activeIdx].scrollIntoView({ block: 'nearest' });
            } else {
                activeOwner.removeAttribute('aria-activedescendant');
                menu.removeAttribute('aria-activedescendant');
            }
        }

        function personaRow(avatarId, indent = false) {
            const name = getPersonaName(avatarId);
            const title = getPersonaTitle(avatarId);
            const isCurrent = avatarId === current;
            const row = el('div', {
                cls: `pt-quick-row${isCurrent ? ' pt-current' : ''}${indent ? ' pt-indent' : ''}`,
                attrs: { role: 'menuitemradio', 'aria-checked': String(isCurrent), 'data-avatar-id': avatarId, 'data-search': `${name} ${title}`.toLowerCase() },
                on: {
                    mousedown: (e) => e.preventDefault(),
                    click: async () => {
                        if (quickMenu !== menu || quickMenuState !== 'open') return;
                        closeQuickMenu({ restoreFocus: true });
                        const selectionRequest = quickMenuRequest;
                        try { await personasApi.setUserAvatar(avatarId); }
                        catch (e) {
                            if (selectionRequest === quickMenuRequest) setQuickStatus('Could not switch persona. Activate Switch persona to retry.');
                            error('setUserAvatar failed', e);
                        }
                        updateQuickButton();
                    },
                    mouseenter: () => showTooltip(row, name, title),
                    mouseleave: hideTooltip,
                },
            },
                el('img', { cls: 'pt-quick-avatar', attrs: { src: thumbUrl(avatarId), alt: '', loading: 'lazy' } }),
                el('div', { cls: 'pt-quick-info' },
                    el('div', { cls: 'pt-quick-name', text: name }),
                    title ? el('div', { cls: 'pt-quick-sub', text: title }) : null,
                ),
                isCurrent ? el('div', { cls: 'pt-quick-check' }, icon('fa-check')) : null,
            );
            return row;
        }

        const availableSet = new Set(avatars);
        const folders = getAllFolders()
            .map(f => ({ ...f, members: f.members.filter(id => availableSet.has(id)) }))
            .filter(f => f.members.length > 0);
        const grouped = new Set(folders.flatMap(f => f.members));
        const ungrouped = avatars.filter(id => !grouped.has(id));

        for (const folder of folders) {
            const memberRows = [];
            const expandedByDefault = folder.members.includes(current);
            const description = getFolderDescription(folder.name);
            const folderRow = el('div', {
                cls: `pt-quick-row pt-quick-folder${expandedByDefault ? ' pt-expanded' : ''}`,
                attrs: { role: 'menuitem', 'aria-expanded': String(expandedByDefault) },
                on: {
                    mousedown: (e) => e.preventDefault(),
                    click: () => {
                        if (quickMenu !== menu || quickMenuState !== 'open') return;
                        const expanded = folderRow.classList.toggle('pt-expanded');
                        folderRow.setAttribute('aria-expanded', String(expanded));
                        memberRows.forEach(r => r.classList.toggle('pt-hidden', !expanded));
                        if (!expanded && memberRows.includes(rows[activeIdx])) setActive(rows.indexOf(folderRow));
                    },
                },
            },
                el('div', { cls: 'pt-quick-folder-preview' },
                    el('img', { cls: 'pt-quick-avatar', attrs: { src: thumbUrl(folder.members[0]), alt: '', loading: 'lazy' } }),
                    el('div', { cls: 'pt-quick-folder-badge' }, icon('fa-folder')),
                ),
                el('div', { cls: 'pt-quick-info' },
                    el('div', { cls: 'pt-quick-name', text: folder.name }),
                    description ? el('div', { cls: 'pt-quick-sub', text: description }) : null,
                ),
                el('span', { cls: 'pt-quick-count', text: String(folder.members.length) }),
                icon('fa-chevron-right pt-chevron'),
            );
            addRow(folderRow);
            for (const id of folder.members) {
                const row = personaRow(id, true);
                parentFolders.set(row, folderRow);
                if (!expandedByDefault) row.classList.add('pt-hidden');
                memberRows.push(row);
                addRow(row);
            }
        }

        const separator = folders.length && ungrouped.length ? el('div', { cls: 'pt-quick-separator' }) : null;
        if (separator) list.append(separator);
        for (const id of ungrouped) {
            const row = personaRow(id);
            addRow(row);
        }

        const searchInput = el('input', {
            cls: 'pt-input pt-quick-search',
            attrs: { type: 'search', placeholder: 'Search personas…', 'aria-label': 'Search personas', 'aria-controls': 'quickPersonaMenu' },
            on: {
                input: () => {
                    const needle = searchInput.value.trim().toLowerCase();
                    const shownAvatars = new Set();
                    for (const row of rows) {
                        if (!needle) {
                            const folder = parentFolders.get(row);
                            row.classList.toggle('pt-hidden', !!folder && !folder.classList.contains('pt-expanded'));
                        } else {
                            const avatarId = row.getAttribute('data-avatar-id');
                            const match = (row.getAttribute('data-search') || '').includes(needle);
                            const show = !!avatarId && match && !shownAvatars.has(avatarId);
                            row.classList.toggle('pt-hidden', !show);
                            if (show) shownAvatars.add(avatarId);
                        }
                        row.classList.toggle('pt-search-result', !!needle && row.hasAttribute('data-avatar-id'));
                    }
                    separator?.classList.toggle('pt-hidden', !!needle);
                    emptyState.textContent = needle ? 'No matching personas' : 'No personas available';
                    emptyState.classList.toggle('pt-hidden', rows.some(row => !row.classList.contains('pt-hidden')));
                    setActive(-1);
                },
            },
        });

        const showSearch = avatars.length > 6;
        activeOwner = showSearch ? searchInput : menu;
        menu.append(
            el('div', { cls: 'pt-quick-header' },
                el('span', { cls: 'pt-quick-header-title', text: 'Personas' }),
                el('span', { cls: 'pt-quick-header-count', text: String(avatars.length) }),
            ),
            showSearch ? searchInput : null,
            list,
            emptyState,
        );

        quickMenuKeyHandler = (e) => {
            if (quickMenu !== menu) return;
            if (e.altKey || e.ctrlKey || e.metaKey || isComposingKey(e)) return;
            const visible = rows.filter(r => !r.classList.contains('pt-hidden'));
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (!visible.length) return;
                const currentVisibleIdx = visible.indexOf(rows[activeIdx]);
                const nextVisibleIdx = e.key === 'ArrowDown'
                    ? (currentVisibleIdx + 1) % visible.length
                    : currentVisibleIdx <= 0 ? visible.length - 1 : currentVisibleIdx - 1;
                setActive(rows.indexOf(visible[nextVisibleIdx]));
                return;
            }
            if (e.key === 'Enter' || (e.key === ' ' && e.target === menu)) {
                e.preventDefault();
                e.stopPropagation();
                if (e.repeat) return;
                if (rows[activeIdx] && !rows[activeIdx].classList.contains('pt-hidden')) rows[activeIdx].click();
            }
        };

        document.body.append(menu);
        stopQuickMenuPositioning = trackOverlayPosition(menu, document.getElementById('quickPersona'), { preferAbove: true });
        quickMenu = menu;
        quickMenuState = 'open';
        setQuickStatus();
        const trigger = document.getElementById('quickPersona');
        trigger?.removeAttribute('aria-busy');
        trigger?.setAttribute('aria-expanded', 'true');
        document.getElementById('quickPersonaCaret')?.classList.replace('fa-caret-up', 'fa-caret-down');
        requestAnimationFrame(() => { if (quickMenu === menu) menu.classList.add('pt-open'); });
        activeOwner.focus({ preventScroll: true });
    }

    // ============================================
    // EVENTS + INIT
    // ============================================

    function onPersonaDeleted(payload) {
        const avatarId = payload && typeof payload === 'object' ? payload.avatarId : payload;
        if (avatarId) {
            const affectedFolders = new Set(getFoldersOf(avatarId));
            const hadFolders = Object.hasOwn(settings.personaGroups, avatarId);
            const hadTags = Object.hasOwn(settings.persona_tag_map, avatarId);
            delete settings.personaGroups[avatarId];
            delete settings.persona_tag_map[avatarId];
            const pruned = pruneOrphanDescriptions();
            if (hadFolders || hadTags || pruned) saveSettings();
            if (activePopover?.personaId === avatarId) closePopover();
            reconcileFolderUi(affectedFolders);
        }
        updateQuickButton();
        activePopover?.refreshPersonas?.();
        scheduleDecorate();
    }

    async function loadPersonasApi() {
        personasApi = await import('/scripts/personas.js');
        if (!powerUser) {
            try { powerUser = (await import('/scripts/power-user.js')).power_user; }
            catch (e) { error('power_user unavailable', e); }
        }
    }

    async function init() {
        settings = getSettings();
        await loadPersonasApi();
        const migrated = await migrateFromOldExtensions();
        const pruned = pruneOrphanDescriptions();
        if (migrated || pruned) saveSettings();
        installFilter();

        addQuickButton();
        createFolderHeader();
        createTagBar();
        startObserver();

        eventSource.on(event_types.CHAT_CHANGED, updateQuickButton);
        eventSource.on(event_types.SETTINGS_UPDATED, updateQuickButton);
        if (event_types.PERSONA_CHANGED) eventSource.on(event_types.PERSONA_CHANGED, updateQuickButton);
        if (event_types.PERSONA_CREATED) eventSource.on(event_types.PERSONA_CREATED, (payload) => {
            const newId = payload && typeof payload === 'object' ? payload.avatarId : null;
            const srcId = payload && typeof payload === 'object' ? payload.duplicatedFromAvatarId : null;
            // Duplicates inherit the source persona's folders and tags, so
            // duplicating inside a folder keeps the copy in that folder.
            if (newId && srcId) {
                let inherited = false;
                if (settings.personaGroups[srcId]?.length) {
                    settings.personaGroups[newId] = [...settings.personaGroups[srcId]];
                    inherited = true;
                }
                if (settings.persona_tag_map[srcId]?.length) {
                    settings.persona_tag_map[newId] = [...settings.persona_tag_map[srcId]];
                    inherited = true;
                }
                if (inherited) saveSettings();
            }
            // A persona created OUTSIDE the current folder/tag scope would be
            // filtered out of ST's post-create render and look like the creation
            // failed — drop back to the root view unless it's visible here.
            // (The event fires before ST's re-render, so its own navigation to
            // the new card works natively either way.)
            if (newId && personasApi.isPersonaPanelOpen?.()) {
                const outsideFolder = view.folder && !isSearchActive() && !getFoldersOf(newId).includes(view.folder);
                const excludedByTags = view.tags.length && !hasAllTags(newId, view.tags);
                if (outsideFolder) view.folder = null;
                if (excludedByTags) view.tags = [];
                // The unfiltered root hides grouped personas, including copies
                // created while already at the root. Reveal their first folder.
                if (!view.folder && !view.tags.length && !isSearchActive()) {
                    view.folder = getAllFolders().find(folder => folder.members.includes(newId))?.name || null;
                }
                renderTagBar();
            }
            updateQuickButton();
            activePopover?.refreshPersonas?.();
            scheduleDecorate();
        });
        if (event_types.PERSONA_RENAMED) eventSource.on(event_types.PERSONA_RENAMED, () => { updateQuickButton(); activePopover?.refreshPersonas?.(); scheduleDecorate(); });
        // PERSONA_UPDATED fires per keystroke while typing a persona description —
        // the quick-button refresh is cheap (src-compare, no fetch), so no decorate.
        if (event_types.PERSONA_UPDATED) eventSource.on(event_types.PERSONA_UPDATED, () => { updateQuickButton(); activePopover?.refreshPersonas?.(); });
        if (event_types.PERSONA_DELETED) eventSource.on(event_types.PERSONA_DELETED, onPersonaDeleted);

        document.addEventListener('keydown', handleQuickMenuKeydown, true);
        document.addEventListener('pointerdown', dismissQuickMenuOutside, true);
        document.addEventListener('focusin', dismissQuickMenuOutside, true);
        window.addEventListener('blur', () => closeQuickMenu());
        document.addEventListener('click', dismissQuickMenuOutside);

        // ST's own search re-renders the list and our observer re-decorates, but
        // clearing the box must also restore the folder/tag view scoping.
        const searchBar = document.getElementById('persona_search_bar');
        if (searchBar) {
            searchBar.addEventListener('input', () => {
                if (!searchBar.value.trim() && (view.folder || view.tags.length || getAllFolders().length)) refreshListSoon();
            });
        }

        updateQuickButton();
        // Re-render once so the injected filter applies to the initially rendered list.
        await refreshList();
        console.info(`[${EXT_NAME}] v${VERSION} ready`);
    }

    jQuery(async () => {
        try { await init(); }
        catch (e) { error('Fatal init error:', e); }
    });
})();
