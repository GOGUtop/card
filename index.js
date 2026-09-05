const EXTENSION_NAME = 'cardvault-sillytavern-extension';
const LEGACY_GLOBAL_PERSISTENT_TOKEN_KEY = 'cardvault_persistent_token_v2';
const LEGACY_SESSION_TOKEN_KEY = 'cardvault_session_token_v1';
const CARDVAULT_ACCESS_POLICY = Object.freeze({
    'default-user': 'card2',
    'vvv': 'card2',
    '1234': 'admin',
    'jiuwo': 'admin',
    'dashanzaici': 'admin',
    'xixiart': 'admin',
    'chiyue': 'admin',
    'zexin': null,
    'cunka': null,
});
const AI_CLASSIFICATION_TAXONOMIES = Object.freeze({
    // card2 卡库：保留 0.4.5 的分类体系与版本号，已经分类过的 x 卡不会被强制重跑。
    card2: Object.freeze({
        version: 2,
        name: 'card2 分类',
        tags: Object.freeze([
            '纯文字', '轻前端', '重前端', '纯爱', 'NTL', 'NTR', '多路线',
            '伪娘/男娘', '御姐/人妻/熟女/母系', '幻想', '病娇/黑化/恶堕', '人外',
            '乱伦', '系统流', '同人/二创', '群像/多角色/后宫', '女性视角', '百合', '现代', '古风',
        ]),
        labels: Object.freeze({}),
    }),
    // 狗骨卡库：admin 使用用户给出的另一套类脑标签。
    admin: Object.freeze({
        version: 3,
        name: '狗骨分类',
        tags: Object.freeze([
            'BG', 'GB', 'BL', 'GL', '古代', '现代', '架空', '未来', '奇幻', '科幻',
            '西方', '同人', '纯文字', '前端美化', 'ABO', '向哨', '纯净', '人外', '多人', '合集',
        ]),
        labels: Object.freeze({
            '古代': '🪈 古代',
            '现代': '💍 现代',
            '架空': '🌠 架空',
            '未来': '🤖 未来',
            '奇幻': '🔮 奇幻',
            '科幻': '👾 科幻',
            '西方': '🪽 西方',
            '同人': '🥰 同人',
            '纯文字': '✏️ 纯文字',
            '前端美化': '💻 前端美化',
            'ABO': '🐰 ABO',
            '向哨': '🐺 向哨',
            '纯净': '🌺 纯净',
            '人外': '🐺 人外',
            '多人': '🍀 多人',
            '合集': '💯 合集',
        }),
    }),
});

function classificationTaxonomy() {
    const account = requiredCardVaultAccount();
    return AI_CLASSIFICATION_TAXONOMIES[account] || AI_CLASSIFICATION_TAXONOMIES.card2;
}

function currentCategoryTags() {
    return classificationTaxonomy().tags;
}

function currentClassificationTaxonomyVersion() {
    return classificationTaxonomy().version;
}

function aiTagLabel(tag) {
    const taxonomy = classificationTaxonomy();
    return taxonomy.labels?.[tag] || tag;
}
const DEFAULT_SETTINGS = Object.freeze({
    apiUrl: 'http://aaa.xixisillytavern.top:8788',
    username: 'card2',
    preferServerProxy: true,
    playArchiveMap: {},
    aiClassifications: {},
    classifierApiUrl: '',
    classifierApiKey: '',
    classifierModel: '',
    classifierModels: [],
    importGuardianMap: {},
});

// fixed78: CardVault traffic is same-origin through the VVV server plugin.
// The browser never receives or stores the real CardVault bearer token/password.
const CARDVAULT_SERVER_SESSION_BASE = '/api/plugins/vvv-theater-memory-server/cardvault';
const CARDVAULT_SERVER_SESSION_SENTINEL = 'server-managed-session';

let activeToken = '';
let verifiedTokenAccount = '';
let cardVaultTransportMode = 'direct';
let cardVaultProxyReady = false;
let sillyTavernUserHandle = '';
let allowedCardVaultUsername = '';
let cardVaultAccessDisabled = false;
let activeTokenStorageKey = '';
let initialized = false;
let importGuardianCleanups = [];
let importGuardianRunning = false;
let importGuardianModulePromise = null;
let lastImportGuardianSweep = 0;
let overlayAbortController = null;
let mobileViewportCleanup = null;
let coverObjectUrls = new Set();
let coverUrlByCardId = new Map();
let selectionMode = false;
let selectedCardIds = new Set();
let batchRestorePauseRequested = false;
let batchRestorePaused = false;
let lastBatchRestoreFailures = [];
let playArchiveServerMeta = { pagination:'unknown', total:null, loaded:0 };
let loadedCards = [];
let visibleCards = [];
let visiblePlayArchives = [];
let currentLibraryQuery = '';
let currentLibraryMode = 'cards';
let currentAiCategoryFilter = '全部';
let aiClassificationRunning = false;
let lastAiFailures = [];
let lastAiFailureIds = new Set();
let aiTagFitResizeObserver = null;
let aiTagFitResizeBound = false;
let aiTagFitRaf = 0;
let coverIntersectionObserver = null;
let coverLoadQueue = [];
let coverLoadsActive = 0;
function coverLoadConcurrency() {
    return shouldUseMobileLibrary() ? 6 : 2;
}
let cardRenderGeneration = 0;
const CARD_LIST_CACHE_VERSION = 1;
let cardListRefreshPromise = null;
const libraryViewState = {
    cards: { query: '', scrollTop: 0, anchorId: '', anchorOffset: 0, category: '全部' },
    play: { query: '', scrollTop: 0, anchorId: '', anchorOffset: 0 },
};

function context() {
    if (!globalThis.SillyTavern?.getContext) {
        throw new Error('CardVault：无法读取 SillyTavern 上下文');
    }
    return globalThis.SillyTavern.getContext();
}


async function loadSillyTavernAccount() {
    let handle = 'default-user';
    try {
        const response = await fetch('/api/users/me', {
            method: 'GET', credentials: 'same-origin', cache: 'no-store',
        });
        if (response.ok) {
            const data = await response.json();
            handle = String(data?.handle || handle).trim().toLowerCase() || handle;
        }
    } catch (error) {
        console.warn('[CardVault] 无法读取酒馆账号，继续使用本机独立登录模式', error);
    }
    sillyTavernUserHandle = handle;
    cardVaultAccessDisabled = false;
    refreshAuthIdentity();
    return {
        handle: sillyTavernUserHandle,
        cardVaultUsername: allowedCardVaultUsername,
        disabled: false,
    };
}

function refreshAuthIdentity() {
    const cfg = extensionSettings();
    const username = String(cfg.username || DEFAULT_SETTINGS.username || 'card2').trim() || 'card2';
    cfg.username = username;
    allowedCardVaultUsername = username;
    cardVaultAccessDisabled = false;
    const handle = String(sillyTavernUserHandle || 'default-user').trim().toLowerCase() || 'default-user';
    let apiScope = '';
    try { apiScope = cleanBase(cfg.apiUrl || DEFAULT_SETTINGS.apiUrl); } catch { apiScope = String(cfg.apiUrl || DEFAULT_SETTINGS.apiUrl || ''); }
    const nextKey = `cardvault_standalone_token_v1:${handle}:${encodeURIComponent(apiScope)}:${username}`;
    if (nextKey !== activeTokenStorageKey) {
        activeTokenStorageKey = nextKey;
        activeToken = '';
        verifiedTokenAccount = '';
        cardVaultTransportMode = 'direct';
        cardVaultProxyReady = false;
    }
    return username;
}

function requiredCardVaultAccount() {
    return refreshAuthIdentity();
}

function removeCardVaultUi() {
    closeOverlay();
    document.querySelectorAll('#cardvault_settings').forEach(node => node.remove());
}

function extensionSettings() {
    const ctx = context();
    const root = ctx.extensionSettings || globalThis.extension_settings;
    if (!root) throw new Error('CardVault：无法读取扩展设置');

    // 0.4.27：绝不在每次读取时替换设置对象。
    // 设置页会长期持有 cfg 引用；旧版反复 spread 成新对象会让输入框和分类器读到两个不同对象，
    // 出现“明明已经填写 API 地址，拉取模型却仍说未填写”的假空配置。
    let cfg = root[EXTENSION_NAME];
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        cfg = {};
        root[EXTENSION_NAME] = cfg;
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (Object.prototype.hasOwnProperty.call(cfg, key)) continue;
        if (Array.isArray(value)) cfg[key] = [...value];
        else if (value && typeof value === 'object') cfg[key] = { ...value };
        else cfg[key] = value;
    }
    cfg.playArchiveMap = cfg.playArchiveMap && typeof cfg.playArchiveMap === 'object' ? cfg.playArchiveMap : {};
    cfg.aiClassifications = cfg.aiClassifications && typeof cfg.aiClassifications === 'object' ? cfg.aiClassifications : {};
    cfg.classifierModels = Array.isArray(cfg.classifierModels) ? cfg.classifierModels : [];
    cfg.importGuardianMap = cfg.importGuardianMap && typeof cfg.importGuardianMap === 'object' ? cfg.importGuardianMap : {};
    return cfg;
}

function saveSettings() {
    const ctx = context();
    const save = ctx.saveSettingsDebounced || globalThis.saveSettingsDebounced;
    if (typeof save === 'function') save();
}

function cleanBase(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    try {
        const url = new URL(text, location.href);
        if (!/^https?:$/.test(url.protocol)) throw new Error();
        return url.origin + url.pathname.replace(/\/+$/, '');
    } catch {
        throw new Error('服务器地址格式不正确');
    }
}

function normalizeClassifierApiBase(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    try {
        const url = new URL(text, location.href);
        if (!/^https?:$/.test(url.protocol)) throw new Error();
        let path = url.pathname.replace(/\/+$/, '');
        path = path.replace(/\/(?:chat\/completions|models)$/i, '');
        return `${url.origin}${path}`.replace(/\/+$/, '');
    } catch {
        throw new Error('分类 API 地址格式不正确');
    }
}

function classifierConfig() {
    const cfg = extensionSettings();
    cfg.classifierApiUrl = String(cfg.classifierApiUrl || '').trim();
    cfg.classifierApiKey = String(cfg.classifierApiKey || '').trim();
    cfg.classifierModel = String(cfg.classifierModel || '').trim();
    cfg.classifierModels = Array.isArray(cfg.classifierModels)
        ? [...new Set(cfg.classifierModels.map(value => String(value || '').trim()).filter(Boolean))]
        : [];
    return cfg;
}

function classifierApiSummary() {
    const cfg = classifierConfig();
    return cfg.classifierModel ? `独立分类 API · ${cfg.classifierModel}` : '独立分类 API · 未配置模型';
}

function classifierHeaders() {
    const cfg = classifierConfig();
    const headers = new Headers({ 'Content-Type': 'application/json', 'Accept': 'application/json' });
    if (cfg.classifierApiKey) headers.set('Authorization', `Bearer ${cfg.classifierApiKey}`);
    return headers;
}

function normalizeClassifierModelList(payload) {
    const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.models)
                ? payload.models
                : [];
    return [...new Set(rows.map(item => {
        if (typeof item === 'string') return item.trim();
        return String(item?.id || item?.name || item?.model || '').trim();
    }).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

async function readClassifierError(response) {
    let raw = '';
    try { raw = await response.text(); } catch { raw = ''; }
    let body = raw;
    if (raw) {
        try { body = JSON.parse(raw); } catch { /* plain text */ }
    }
    const message = typeof body === 'string'
        ? body
        : body?.error?.message || body?.message || body?.detail || body?.error || '';
    return String(message || `HTTP ${response.status}`).replace(/\s+/g, ' ').trim().slice(0, 700);
}

async function fetchClassifierModels() {
    const cfg = classifierConfig();
    const originalBase = normalizeClassifierApiBase(cfg.classifierApiUrl);
    if (!originalBase) throw new Error('请先填写独立分类 API 地址');
    const bases = [originalBase];
    if (!/\/v1$/i.test(originalBase)) bases.push(`${originalBase}/v1`);
    const errors = [];
    for (const base of [...new Set(bases)]) {
        try {
            const response = await request(`${base}/models`, {
                method: 'GET',
                headers: classifierHeaders(),
                cache: 'no-store',
            }, 30000);
            if (!response.ok) {
                errors.push(`${base}/models → HTTP ${response.status}：${await readClassifierError(response)}`);
                continue;
            }
            let payload;
            try { payload = await response.json(); } catch {
                errors.push(`${base}/models → 返回内容不是 JSON`);
                continue;
            }
            const models = normalizeClassifierModelList(payload);
            if (!models.length) {
                errors.push(`${base}/models → 没有可识别模型`);
                continue;
            }
            cfg.classifierApiUrl = base;
            cfg.classifierModels = models;
            if (!cfg.classifierModel || !models.includes(cfg.classifierModel)) cfg.classifierModel = models[0];
            saveSettings();
            return models;
        } catch (error) {
            errors.push(`${base}/models → ${String(error?.message || error)}`);
        }
    }
    throw new Error(`拉取模型失败：${errors.join('；').slice(0, 900)}`);
}

function extractClassifierText(payload) {
    if (typeof payload === 'string') return payload;
    if (!payload || typeof payload !== 'object') return '';

    const choice = payload?.choices?.[0];
    const message = choice?.message;
    const directCandidates = [
        message?.content,
        message?.reasoning_content,
        message?.reasoning,
        message?.text,
        choice?.text,
        choice?.content,
        payload?.output_text,
        payload?.text,
        payload?.response,
        payload?.result,
    ];
    for (const value of directCandidates) {
        if (typeof value === 'string' && value.trim()) return value;
        if (Array.isArray(value)) {
            const text = value.map(part => typeof part === 'string' ? part : (part?.text || part?.content || part?.value || '')).join('');
            if (text.trim()) return text;
        }
    }

    // OpenAI Responses / 部分中转站：output[].content[].text / output_text
    if (Array.isArray(payload?.output)) {
        const text = payload.output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
            .map(part => part?.text || part?.content || part?.value || '').join('');
        if (text.trim()) return text;
    }

    // Gemini 原生/半兼容返回：candidates[0].content.parts[].text
    const geminiParts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(geminiParts)) {
        const text = geminiParts.map(part => part?.text || part?.content || '').join('');
        if (text.trim()) return text;
    }

    // 某些结构化输出会被放进 tool/function arguments，而 message.content 为空。
    const toolCalls = message?.tool_calls;
    if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
            const args = call?.function?.arguments ?? call?.arguments;
            if (typeof args === 'string' && args.trim()) return args;
            if (args && typeof args === 'object') {
                try { return JSON.stringify(args); } catch { /* ignore */ }
            }
        }
    }
    const fnArgs = message?.function_call?.arguments;
    if (typeof fnArgs === 'string' && fnArgs.trim()) return fnArgs;

    // 最后做一层很保守的递归，只查常见承载字段，避免把错误信息误当正文。
    for (const key of ['data', 'body', 'completion', 'response_data']) {
        const nested = payload?.[key];
        if (nested && nested !== payload) {
            const text = extractClassifierText(nested);
            if (String(text || '').trim()) return text;
        }
    }
    return '';
}

function extractClassifierStructuredObject(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const message = payload?.choices?.[0]?.message;
    const candidates = [
        message?.parsed,
        message?.json,
        payload?.output_parsed,
        payload?.parsed,
        payload?.structured_output,
    ];
    for (const value of candidates) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    return null;
}

function classifierPayloadDiagnostic(payload) {
    try {
        const choice = payload?.choices?.[0] || {};
        const message = choice?.message || {};
        const finish = choice?.finish_reason || payload?.candidates?.[0]?.finishReason || payload?.finish_reason || '';
        const rootKeys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12).join(',') : typeof payload;
        const msgKeys = message && typeof message === 'object' ? Object.keys(message).slice(0, 12).join(',') : typeof message;
        return `finish=${finish || 'unknown'}；root=[${rootKeys || '-'}]；message=[${msgKeys || '-'}]`;
    } catch {
        return '无法生成返回诊断';
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
}

function safeFilename(value, fallback = 'character') {
    const name = String(value || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    return name.slice(0, 160) || fallback;
}

function getSessionToken() {
    if (activeToken) return activeToken;
    if (!activeTokenStorageKey) return '';
    try {
        activeToken = localStorage.getItem(activeTokenStorageKey) || '';
    } catch { activeToken = ''; }
    return activeToken;
}

function setSessionToken(token) {
    activeToken = String(token || '');
    verifiedTokenAccount = '';
    if (!activeTokenStorageKey) return;
    try {
        if (activeToken) localStorage.setItem(activeTokenStorageKey, activeToken);
        else localStorage.removeItem(activeTokenStorageKey);
        sessionStorage.removeItem(LEGACY_SESSION_TOKEN_KEY);
    } catch { /* private mode can reject storage */ }
}

function accountDisplayName(username) {
    const value = String(username || '').trim();
    if (value === 'admin') return '狗骨';
    if (value === 'card2' || value === 'x') return 'x';
    return value || '未选择';
}

function setStatus(message, state = 'idle') {
    const box = document.querySelector('#cv_status');
    if (!box) return;
    box.dataset.state = state;
    const text = box.querySelector('.cv-status-text');
    if (text) text.textContent = message;
}

function notify(type, message) {
    const fn = globalThis.toastr?.[type];
    if (typeof fn === 'function') fn(message);
    else console[type === 'error' ? 'error' : 'log'](`[CardVault] ${message}`);
}

function cardVaultConfirm({
    title = '请确认',
    message = '',
    confirmText = '确认',
    cancelText = '取消',
    danger = false,
} = {}) {
    return new Promise(resolve => {
        document.querySelector('.cv-confirm-layer')?.remove();

        // 0.4.24：手机端改用原生 <dialog> Top Layer。
        // 这样确认框不再受酒馆页面滚动、transform、状态栏/安全区或 WebView 可视视口影响。
        const canUseDialog = typeof HTMLDialogElement !== 'undefined';
        const layer = document.createElement(canUseDialog ? 'dialog' : 'div');
        layer.className = `cv-confirm-layer${canUseDialog ? ' cv-confirm-dialog' : ' cv-confirm-fallback'}`;
        layer.setAttribute('role', 'dialog');
        layer.setAttribute('aria-modal', 'true');
        layer.innerHTML = `
            <div class="cv-confirm-card">
                <div class="cv-confirm-icon ${danger ? 'is-danger' : ''}">
                    <i class="fa-solid ${danger ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i>
                </div>
                <div class="cv-confirm-copy">
                    <div class="cv-confirm-title">${escapeHtml(title)}</div>
                    <div class="cv-confirm-message">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
                </div>
                <div class="cv-confirm-actions">
                    <button type="button" class="menu_button cv-confirm-cancel">${escapeHtml(cancelText)}</button>
                    <button type="button" class="menu_button cv-confirm-ok ${danger ? 'is-danger' : ''}">${escapeHtml(confirmText)}</button>
                </div>
            </div>`;

        let settled = false;
        const cleanupListeners = () => {
            document.removeEventListener('keydown', onKeyDown, true);
        };
        const finish = value => {
            if (settled) return;
            settled = true;
            cleanupListeners();
            try {
                if (canUseDialog && layer.open) layer.close();
            } catch {}
            layer.remove();
            resolve(Boolean(value));
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
            }
        };

        layer.querySelector('.cv-confirm-cancel')?.addEventListener('click', () => finish(false));
        layer.querySelector('.cv-confirm-ok')?.addEventListener('click', () => finish(true));
        layer.addEventListener('click', event => {
            if (event.target === layer) finish(false);
        });
        layer.addEventListener('cancel', event => {
            event.preventDefault();
            finish(false);
        });
        document.addEventListener('keydown', onKeyDown, true);
        document.body.appendChild(layer);

        if (canUseDialog && typeof layer.showModal === 'function') {
            try {
                layer.showModal();
            } catch {
                layer.classList.add('cv-confirm-fallback');
            }
        }

        // iPhone/iPad 不主动 focus：Safari/WebView 有时会为了把焦点滚入视野而把页面推到顶部。
        // 仅桌面精细指针设备保留键盘焦点体验。
        const desktopFinePointer = globalThis.matchMedia?.('(pointer: fine)')?.matches && globalThis.innerWidth > 700;
        if (desktopFinePointer) {
            requestAnimationFrame(() => layer.querySelector('.cv-confirm-cancel')?.focus({ preventScroll: true }));
        }
    });
}

const SEIKAN_ROLE_MESSAGES = Object.freeze({
    owner:
        '【Seikan身份选择】我选择以店主身份开始。请锁定店主模式，从店主开场正式开始。' +
        '<!-- seikan_mode_owner __seikan_owner_opening_data__ seikan_customer_roster ' +
        'seikan_shop_background seikan_shop_layout seikan_massage_service ' +
        'seikan_massage_prose seikan_debt_system seikan_affection_rules ' +
        'seikan_trust_rules seikan_relationship_rules -->',
    customer:
        '【Seikan身份选择】我选择以客人身份开始。请锁定客人模式，并让我选择一名按摩师。' +
        '<!-- seikan_mode_customer seikan_shop_owner seikan_shop_background ' +
        'seikan_shop_layout seikan_massage_service seikan_massage_prose ' +
        'seikan_special_items -->',
});

async function sendSeikanRoleChoice(role) {
    const message = SEIKAN_ROLE_MESSAGES[String(role || '')];
    if (!message) return false;

    // 0.4.12：优先走 SillyTavern 自己的 STscript 执行器。
    // 这条路径不依赖桌面/手机端输入框 DOM 是否一致，能直接“发送用户消息 + 触发回复”。
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (ctx && typeof ctx.executeSlashCommandsWithOptions === 'function') {
            const scriptSafe = message.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
            const result = await ctx.executeSlashCommandsWithOptions(
                `/send ${scriptSafe} | /trigger`,
                { source: 'cardvault-seikan-role' },
            );
            if (!result?.isError) return true;
            console.warn('[CardVault] Seikan STscript send failed, fallback to DOM:', result?.errorMessage || result);
        }
    } catch (error) {
        console.warn('[CardVault] Seikan STscript bridge unavailable, fallback to DOM:', error);
    }

    // DOM 兜底：兼容较旧 ST，以及个别没有公开 executeSlashCommandsWithOptions 的版本。
    const textarea = document.querySelector('#send_textarea')
        || document.querySelector('textarea[name="send_textarea"]')
        || document.querySelector('[contenteditable="true"][data-placeholder]');
    if (!textarea) {
        notify('error', '没有找到酒馆输入框，请刷新页面后重试');
        return false;
    }

    if (textarea instanceof HTMLTextAreaElement || textarea instanceof HTMLInputElement) {
        try {
            const proto = Object.getPrototypeOf(textarea);
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (descriptor?.set) descriptor.set.call(textarea, message);
            else textarea.value = message;
        } catch {
            textarea.value = message;
        }
        try { globalThis.jQuery?.(textarea).val(message).trigger('input').trigger('change'); } catch (_) {}
        try {
            textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: message,
            }));
        } catch {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        textarea.textContent = message;
        try { textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message })); }
        catch { textarea.dispatchEvent(new Event('input', { bubbles: true })); }
    }

    const sendButton = document.querySelector('#send_but')
        || document.querySelector('[data-i18n="[title]Send"]')
        || document.querySelector('button[title="Send"]')
        || document.querySelector('[aria-label="Send"]');
    if (!sendButton) {
        notify('warning', '身份选择已填入输入框，请手动点击发送');
        textarea.focus?.();
        return true;
    }

    setTimeout(() => {
        try { sendButton.click(); } catch (_) {
            try { sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (_) {}
        }
    }, 60);
    return true;
}

function roleFromSeikanButton(button) {
    if (!button || button.nodeType !== 1) return '';
    let role = button.getAttribute?.('data-seikan-role') || '';
    if (SEIKAN_ROLE_MESSAGES[role]) return role;
    const text = `${button.getAttribute?.('aria-label') || ''} ${button.textContent || ''}`.replace(/\s+/g, ' ').trim();
    if (text.includes('店主身份') || text.includes('以店主') || text === '店主模式') return 'owner';
    if (text.includes('客人身份') || text.includes('以客人') || text === '客人模式') return 'customer';
    return '';
}

function findSeikanRoleFromEvent(event) {
    const selector = '.seikan-choice-button[data-seikan-role]';
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
    const nodes = path.length ? path : [event?.target];

    for (const node of nodes) {
        if (!node || node.nodeType !== 1) continue;
        const direct = node.matches?.(selector) ? node : node.closest?.(selector);
        if (direct) return { button: direct, role: direct.dataset.seikanRole };

        // 电脑端有些主题/渲染器会重建按钮并丢 class/data 属性，因此按按钮文字再兜一次。
        const button = node.matches?.('button,[role="button"],a') ? node : node.closest?.('button,[role="button"],a');
        if (!button) continue;
        const role = roleFromSeikanButton(button);
        if (!role) continue;
        button.dataset.seikanRole = role;
        button.classList?.add('seikan-choice-button');
        return { button, role };
    }
    return null;
}

function triggerSeikanRoleButton(button, role, event) {
    if (!button || !SEIKAN_ROLE_MESSAGES[String(role || '')]) return false;

    const now = Date.now();
    const last = Number(button.dataset.cardVaultSeikanLast || 0);
    if (now - last < 1000) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        return true;
    }
    button.dataset.cardVaultSeikanLast = String(now);

    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();

    if (button.dataset.cardVaultBusy === '1') return true;
    const originalText = button.textContent;
    button.dataset.cardVaultBusy = '1';
    try { button.disabled = true; } catch (_) {}
    button.textContent = '正在进入……';

    void sendSeikanRoleChoice(role).then(sent => {
        if (!sent) notify('error', 'Seikan 身份按钮发送失败');
    }).catch(error => {
        console.error('[CardVault] Seikan role send error:', error);
        notify('error', `Seikan 身份按钮发送失败：${error?.message || error}`);
    });

    setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.cardVaultBusy = '0';
        try { button.disabled = false; } catch (_) {}
        button.textContent = originalText;
    }, 1400);
    return true;
}

const seikanAttachedRoots = new WeakSet();

function bindSeikanButtons(root = document) {
    if (!root?.querySelectorAll) return;
    const selector = '.seikan-choice-button, .seikan-role-select button, .seikan-role-select [role="button"], button[aria-label*="店主身份"], button[aria-label*="客人身份"], [role="button"][aria-label*="店主身份"], [role="button"][aria-label*="客人身份"]';
    const candidates = [
        ...(root.nodeType === 1 && root.matches?.(selector) ? [root] : []),
        ...(root.querySelectorAll?.(selector) || []),
    ];
    for (const button of candidates) {
        if (!button || button.nodeType !== 1) continue;
        const role = roleFromSeikanButton(button);
        if (!role) continue;

        button.dataset.seikanRole = role;
        button.classList?.add('seikan-choice-button');
        button.style?.setProperty('pointer-events', 'auto', 'important');
        button.style?.setProperty('touch-action', 'manipulation', 'important');
        button.style?.setProperty('cursor', 'pointer', 'important');
        button.style?.setProperty('user-select', 'none', 'important');
        if (button.dataset.cardVaultSeikanBound === '2') continue;
        button.dataset.cardVaultSeikanBound = '2';

        const directHandler = event => triggerSeikanRoleButton(button, role, event);
        // pointerdown/mousedown 是 0.4.12 的电脑端关键兜底：部分桌面主题会在 mouseup/click 前截断事件。
        button.addEventListener('pointerdown', directHandler, true);
        button.addEventListener('mousedown', directHandler, true);
        button.addEventListener('pointerup', directHandler, true);
        button.addEventListener('mouseup', directHandler, true);
        button.addEventListener('touchend', directHandler, { capture: true, passive: false });
        button.addEventListener('click', directHandler, true);
    }
}

function attachSeikanRoot(root) {
    if (!root || seikanAttachedRoots.has(root)) return;
    seikanAttachedRoots.add(root);

    const handler = event => {
        const found = findSeikanRoleFromEvent(event);
        if (!found) return;
        triggerSeikanRoleButton(found.button, found.role, event);
    };

    // 桌面优先在按下阶段就接管；手机继续保留 pointer/touch/click。
    root.addEventListener?.('pointerdown', handler, true);
    root.addEventListener?.('mousedown', handler, true);
    root.addEventListener?.('pointerup', handler, true);
    root.addEventListener?.('mouseup', handler, true);
    root.addEventListener?.('touchend', handler, { capture: true, passive: false });
    root.addEventListener?.('click', handler, true);
    bindSeikanButtons(root);
}

function rescanSeikanInteractiveRoots(root = document, { deepShadowScan = true } = {}) {
    if (!root) return;
    // 普通DOM已经由document级事件委托接管；只给Document/ShadowRoot绑定根监听，
    // 避免Mutation新增一个节点就永久多挂一套pointer/mouse/click监听。
    if (root.nodeType === 9 || root.nodeType === 11) attachSeikanRoot(root);
    bindSeikanButtons(root);

    const handleFrame = frame => {
        if (!frame || frame.nodeType !== 1) return;
        const attachFrame = () => {
            try {
                const doc = frame.contentDocument;
                if (!doc) return;
                attachSeikanRoot(doc);
                bindSeikanButtons(doc);
                // iframe内部首次接管时扫描一次开放 shadowRoot；之后由它自身事件委托处理按钮。
                rescanSeikanInteractiveRoots(doc, { deepShadowScan: true });
            } catch (_) {}
        };
        if (frame.dataset.cardVaultSeikanFrameListener !== '1') {
            frame.dataset.cardVaultSeikanFrameListener = '1';
            frame.addEventListener('load', attachFrame);
        }
        attachFrame();
    };

    if (root.nodeType === 1 && root.matches?.('iframe')) handleFrame(root);
    for (const frame of root.querySelectorAll?.('iframe') || []) handleFrame(frame);

    const attachOpenShadow = host => {
        try {
            if (!host?.shadowRoot) return;
            attachSeikanRoot(host.shadowRoot);
            bindSeikanButtons(host.shadowRoot);
            for (const frame of host.shadowRoot.querySelectorAll?.('iframe') || []) handleFrame(frame);
        } catch (_) {}
    };
    if (root.nodeType === 1) attachOpenShadow(root);
    // U1.7：全量 * 扫描只允许首次接管既有页面；后续新增shadowRoot由attachShadow钩子接管，新增DOM只查iframe。
    if (deepShadowScan) for (const host of root.querySelectorAll?.('*') || []) attachOpenShadow(host);
}

function installInteractiveCardFallbacks() {
    const root = document.documentElement;
    if (root.dataset.cardVaultInteractiveFallbacks === '4') return;
    root.dataset.cardVaultInteractiveFallbacks = '4';

    // 首次加载允许完整扫描一次，保证旧主题/iframe/shadowRoot都能接管。
    rescanSeikanInteractiveRoots(document, { deepShadowScan: true });

    const observer = new MutationObserver(records => {
        const added=[];
        for (const record of records) for (const node of record.addedNodes || []) if (node?.nodeType === 1) added.push(node);
        if (!added.length) return;
        queueMicrotask(() => {
            for (const node of added) {
                if (!node.isConnected) continue;
                // 只扫描新增子树，而不是每次DOM变化后重新扫描整个document。
                rescanSeikanInteractiveRoots(node, { deepShadowScan: false });
            }
        });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // U1.7：不再周期全DOM扫描。对“现有host后来才attachShadow”的少数情况，
    // 在原生attachShadow返回后只接管这个新shadowRoot，成本与实际创建次数成正比。
    const elementProto=globalThis.Element?.prototype;
    if(elementProto?.attachShadow && !elementProto.__cardVaultAttachShadowPatched){
        const originalAttachShadow=elementProto.attachShadow;
        Object.defineProperty(elementProto,'__cardVaultAttachShadowPatched',{value:true,configurable:false});
        elementProto.attachShadow=function cardVaultAttachShadow(init){
            const shadow=originalAttachShadow.call(this,init);
            queueMicrotask(()=>{try{rescanSeikanInteractiveRoots(shadow,{deepShadowScan:true});}catch(_){}});
            return shadow;
        };
    }

    globalThis.cardVaultSeikanFallback = {
        version: '1.0.0-standalone',
        rescan: () => rescanSeikanInteractiveRoots(document, { deepShadowScan: true }),
        send: role => sendSeikanRoleChoice(role),
        testOwner: () => sendSeikanRoleChoice('owner'),
        testCustomer: () => sendSeikanRoleChoice('customer'),
    };
}



async function parseResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    if (!raw) return null;
    if (contentType.includes('application/json')) {
        try { return JSON.parse(raw); } catch { throw new Error(`服务器返回了损坏的 JSON（HTTP ${response.status}）`); }
    }
    return raw;
}

// CardVault 0.4.15：iOS / WebView 免密认证兼容层。
// 某些 WKWebView 对跨端口 credentialed fetch 会直接抛 TypeError: Load failed，
// 但同一请求走 XMLHttpRequest 可以正常完成，因此只在 fetch 的“网络层失败”时降级一次。
function shouldUseXhrFallback(error) {
    const raw = String(error?.message || error || '');
    return /load failed|failed to fetch|fetch failed|network request failed|networkerror|network error/i.test(raw);
}

function requestViaXhr(url, options = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        if (typeof XMLHttpRequest !== 'function') {
            reject(new Error('当前浏览器不支持备用网络通道'));
            return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open(String(options.method || 'GET').toUpperCase(), url, true);
        xhr.timeout = timeoutMs;
        xhr.withCredentials = options.credentials === 'include';
        try {
            const headers = new Headers(options.headers || {});
            headers.forEach((value, key) => xhr.setRequestHeader(key, value));
        } catch { /* ignore malformed optional headers */ }
        xhr.onload = () => {
            try {
                const responseHeaders = new Headers();
                String(xhr.getAllResponseHeaders() || '').trim().split(/[\r\n]+/).forEach(line => {
                    const index = line.indexOf(':');
                    if (index > 0) responseHeaders.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
                });
                resolve(new Response(xhr.responseText ?? '', {
                    status: xhr.status || 200,
                    statusText: xhr.statusText || '',
                    headers: responseHeaders,
                }));
            } catch (error) { reject(error); }
        };
        xhr.onerror = () => reject(new Error('移动端网络请求失败，请检查目标服务是否可访问，并确认 API 允许当前酒馆网页跨域访问'));
        xhr.ontimeout = () => reject(new Error('连接超时，请检查服务器地址和网络'));
        xhr.onabort = () => reject(new Error('请求已取消'));
        if (options.signal) {
            if (options.signal.aborted) { xhr.abort(); return; }
            options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }
        xhr.send(options.body ?? null);
    });
}

async function request(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const timeout = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
    const abortExternal = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', abortExternal, { once: true });
    const requestOptions = { ...options, signal: controller.signal };
    try {
        try {
            return await fetch(url, requestOptions);
        } catch (error) {
            if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
                throw new Error('连接超时，请检查服务器地址和网络');
            }
            if (!shouldUseXhrFallback(error)) throw error;
            console.warn('[CardVault] fetch 网络层失败，正在使用 iOS/WebView XHR 备用通道', error);
            return await requestViaXhr(url, { ...options, signal: externalSignal }, timeoutMs);
        }
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortExternal);
    }
}

async function cardVaultSameOriginHeaders(extraHeaders = {}) {
    let base = {};
    try {
        const direct = context()?.getRequestHeaders ?? globalThis.getRequestHeaders;
        if (typeof direct === 'function') base = direct() || {};
    } catch {}
    if (!Object.keys(base || {}).some(key => /csrf/i.test(key))) {
        try {
            const module = await import('/script.js');
            if (typeof module.getRequestHeaders === 'function') base = { ...base, ...(module.getRequestHeaders() || {}) };
        } catch {}
    }
    const headers = new Headers(base || {});
    for (const [key, value] of new Headers(extraHeaders || {}).entries()) headers.set(key, value);
    headers.delete('Authorization');
    return headers;
}

async function cardVaultServerRequest(path, options = {}, timeoutMs = 30000) {
    const safePath = String(path || '').trim();
    if (!safePath.startsWith('/api/')) throw new Error('CardVault 代理只允许 /api/ 路径');
    const headers = await cardVaultSameOriginHeaders(options.headers || {});
    const url = `${CARDVAULT_SERVER_SESSION_BASE}/proxy?path=${encodeURIComponent(safePath)}`;
    return request(url, {
        ...options,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
    }, timeoutMs);
}

function cardVaultDirectHeaders(extraHeaders = {}) {
    const headers = new Headers(extraHeaders || {});
    const token = getSessionToken();
    if (token && token !== CARDVAULT_SERVER_SESSION_SENTINEL) headers.set('Authorization', `Bearer ${token}`);
    return headers;
}

async function cardVaultDirectRequest(path, options = {}, timeoutMs = 30000) {
    const cfg = extensionSettings();
    const base = cleanBase(cfg.apiUrl || DEFAULT_SETTINGS.apiUrl);
    if (!base) throw new Error('请先填写 CardVault 服务器地址');
    const safePath = String(path || '').trim();
    if (!safePath.startsWith('/api/')) throw new Error('CardVault 只允许 /api/ 路径');
    const headers = cardVaultDirectHeaders(options.headers || {});
    return request(`${base}${safePath}`, {
        ...options,
        headers,
        credentials: 'omit',
        cache: options.cache || 'no-store',
    }, timeoutMs);
}

async function tryCardVaultServerProxy({ force = false } = {}) {
    const cfg = extensionSettings();
    if (cfg.preferServerProxy === false) return false;
    const expected = requiredCardVaultAccount();
    try {
        const headers = await cardVaultSameOriginHeaders();
        const response = await request(`${CARDVAULT_SERVER_SESSION_BASE}/session${force ? '?force=1' : ''}`, {
            method: 'GET', credentials: 'same-origin', cache: 'no-store', headers,
        }, 8000);
        if (!response.ok) return false;
        const data = await parseResponse(response).catch(() => null);
        const actual = String(data?.username || '').trim();
        if (!data?.ok || !actual || actual !== expected) return false;
        cardVaultTransportMode = 'proxy';
        cardVaultProxyReady = true;
        verifiedTokenAccount = actual;
        return true;
    } catch {
        cardVaultProxyReady = false;
        if (cardVaultTransportMode === 'proxy') cardVaultTransportMode = 'direct';
        return false;
    }
}

async function apiFetch(path, options = {}) {
    const { raw = false, timeoutMs = 30000, skipAccountPolicyCheck = false, ...fetchOptions } = options;
    if (!skipAccountPolicyCheck && path !== '/api/me') await ensureAllowedToken();

    let response;
    if (cardVaultTransportMode === 'proxy' && cardVaultProxyReady) {
        response = await cardVaultServerRequest(path, fetchOptions, timeoutMs);
        if (response.status === 404 || response.status === 502 || response.status === 503) {
            cardVaultTransportMode = 'direct';
            cardVaultProxyReady = false;
            response = await cardVaultDirectRequest(path, fetchOptions, timeoutMs);
        }
    } else {
        response = await cardVaultDirectRequest(path, fetchOptions, timeoutMs);
    }

    if (!response.ok) {
        const body = await parseResponse(response).catch(() => null);
        if (response.status === 401 && cardVaultTransportMode !== 'proxy') {
            setSessionToken('');
            verifiedTokenAccount = '';
            setStatus('CardVault 登录已过期，请重新输入密码', 'error');
        }
        const message = typeof body === 'object' ? (body?.message || body?.error) : body;
        throw new Error(message || `CardVault 请求失败（HTTP ${response.status}）`);
    }

    if (raw) return response;
    return parseResponse(response);
}

async function ensureAllowedToken() {
    const required = requiredCardVaultAccount();
    if (verifiedTokenAccount === required) return true;
    if (await tryCardVaultServerProxy()) return true;
    if (!getSessionToken()) throw new Error('尚未登录 CardVault，请输入密码');
    cardVaultTransportMode = 'direct';
    cardVaultProxyReady = false;
    const me = await apiFetch('/api/me', { timeoutMs: 16000, skipAccountPolicyCheck: true });
    const actual = String(me?.username || '').trim();
    if (actual !== required) {
        setSessionToken('');
        verifiedTokenAccount = '';
        closeOverlay();
        throw new Error(`当前令牌属于 ${accountDisplayName(actual)}，但设置里选择的是 ${accountDisplayName(required)}`);
    }
    verifiedTokenAccount = actual;
    return true;
}

async function login(passwordOverride = '') {
    const cfg = extensionSettings();
    cfg.apiUrl = cleanBase(cfg.apiUrl || DEFAULT_SETTINGS.apiUrl);
    const username = requiredCardVaultAccount();
    saveSettings();

    if (await tryCardVaultServerProxy({ force: true })) {
        setStatus(`已连接：${accountDisplayName(username)} · 同源服务端代理`, 'ok');
        return true;
    }

    const password = String(passwordOverride || document.querySelector('#cv_password')?.value || '');
    if (!password) throw new Error('请输入 CardVault 密码');
    setStatus(`正在登录 ${accountDisplayName(username)}……`, 'working');
    const response = await request(`${cfg.apiUrl}/api/login`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'omit',
        cache: 'no-store',
    }, 20000);
    const data = await parseResponse(response).catch(() => ({}));
    if (!response.ok || !data?.token) {
        throw new Error(data?.message || data?.error || `CardVault 登录失败（HTTP ${response.status}）`);
    }
    const actual = String(data?.username || username).trim();
    if (actual !== username) throw new Error(`登录账号不匹配：需要 ${username}，实际 ${actual || 'unknown'}`);
    cardVaultTransportMode = 'direct';
    cardVaultProxyReady = false;
    setSessionToken(String(data.token));
    verifiedTokenAccount = actual;
    const passwordInput = document.querySelector('#cv_password');
    if (passwordInput) passwordInput.value = '';
    setStatus(`已连接：${accountDisplayName(actual)} · 独立直连`, 'ok');
    return true;
}

async function verify({ quiet = false } = {}) {
    const username = requiredCardVaultAccount();
    try {
        if (await tryCardVaultServerProxy()) {
            setStatus(`已连接：${accountDisplayName(username)} · 同源服务端代理`, 'ok');
            return true;
        }
        cardVaultTransportMode = 'direct';
        cardVaultProxyReady = false;
        if (!getSessionToken()) {
            setStatus(`未登录 ${accountDisplayName(username)} · 输入密码后连接`, 'idle');
            return false;
        }
        await ensureAllowedToken();
        setStatus(`已连接：${accountDisplayName(username)} · 独立直连`, 'ok');
        return true;
    } catch (error) {
        if (cardVaultTransportMode !== 'proxy') setSessionToken('');
        verifiedTokenAccount = '';
        const raw = String(error?.message || error || '未知错误');
        const friendly = /mixed content/i.test(raw)
            ? '浏览器阻止 HTTP 混合内容；请改用 HTTPS 卡库地址或启用同源服务端代理'
            : raw;
        setStatus(`连接失败：${friendly}`, 'error');
        if (!quiet) notify('warning', `CardVault 连接失败：${friendly}`);
        return false;
    }
}

function disconnect() {
    setSessionToken('');
    verifiedTokenAccount = '';
    cardVaultTransportMode = 'direct';
    cardVaultProxyReady = false;
    closeOverlay();
    setStatus('已断开', 'idle');
    notify('info', 'CardVault 本机登录令牌已清除');
}

function cleanupCoverUrls() {
    for (const url of coverObjectUrls) URL.revokeObjectURL(url);
    coverObjectUrls.clear();
    coverUrlByCardId.clear();
}

function shouldUseMobileLibrary() {
    const userAgent = String(navigator.userAgent || '');
    const touchDevice = Number(navigator.maxTouchPoints || 0) > 0;
    const coarsePointer = globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    const narrowScreen = Math.min(
        Number(globalThis.innerWidth || 9999),
        Number(globalThis.screen?.width || 9999),
    ) <= 1100;

    return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
        || coarsePointer
        || (touchDevice && narrowScreen)
        || Number(globalThis.innerWidth || 9999) <= 760;
}

function attachMobileViewport(overlay) {
    mobileViewportCleanup?.();
    mobileViewportCleanup = null;

    if (!overlay || !shouldUseMobileLibrary()) return;

    overlay.classList.add('cv-mobile-fullscreen');

    const syncViewport = () => {
        const viewport = globalThis.visualViewport;
        const width = Math.max(1, Math.round(viewport?.width || globalThis.innerWidth || document.documentElement.clientWidth || 1));
        const height = Math.max(1, Math.round(viewport?.height || globalThis.innerHeight || document.documentElement.clientHeight || 1));
        const left = Math.round(viewport?.offsetLeft || 0);
        const top = Math.round(viewport?.offsetTop || 0);

        overlay.style.setProperty('--cv-mobile-width', `${width}px`);
        overlay.style.setProperty('--cv-mobile-height', `${height}px`);
        overlay.style.setProperty('--cv-mobile-left', `${left}px`);
        overlay.style.setProperty('--cv-mobile-top', `${top}px`);
    };

    const viewport = globalThis.visualViewport;
    viewport?.addEventListener('resize', syncViewport);
    viewport?.addEventListener('scroll', syncViewport);
    globalThis.addEventListener('resize', syncViewport);
    globalThis.addEventListener('orientationchange', syncViewport);
    syncViewport();

    mobileViewportCleanup = () => {
        viewport?.removeEventListener('resize', syncViewport);
        viewport?.removeEventListener('scroll', syncViewport);
        globalThis.removeEventListener('resize', syncViewport);
        globalThis.removeEventListener('orientationchange', syncViewport);
    };
}

function closeOverlay() {
    overlayAbortController?.abort();
    overlayAbortController = null;
    mobileViewportCleanup?.();
    mobileViewportCleanup = null;
    resetCoverLoader();
    cleanupCoverUrls();
    document.querySelector('.cv-overlay')?.remove();
    document.body.classList.remove('cv-no-scroll');
    document.documentElement.classList.remove('cv-no-scroll');
}

async function loadCoverNow(img, cardId, signal) {
    try {
        const cachedUrl = coverUrlByCardId.get(String(cardId));
        if (cachedUrl) {
            if (!signal?.aborted && img?.isConnected) {
                img.decoding = 'async';
                try { img.fetchPriority = 'low'; } catch {}
                img.src = cachedUrl;
                img.classList.add('loaded');
            }
            return;
        }
        const response = await apiFetch(`/api/cards/${encodeURIComponent(cardId)}/cover`, { raw: true, signal, timeoutMs: 30000 });
        const blob = await response.blob();
        if (signal?.aborted || !img.isConnected) return;
        const url = URL.createObjectURL(blob);
        coverObjectUrls.add(url);
        coverUrlByCardId.set(String(cardId), url);
        img.decoding = 'async';
        try { img.fetchPriority = 'low'; } catch {}
        img.src = url;
        img.classList.add('loaded');
    } catch {
        if (img?.isConnected) img.classList.add('failed');
    }
}

async function loadCover(img, cardId, signal) {
    return loadCoverNow(img, cardId, signal);
}

function resetCoverLoader() {
    coverIntersectionObserver?.disconnect();
    coverIntersectionObserver = null;
    coverLoadQueue = [];
}

function pumpCoverQueue() {
    while (coverLoadsActive < coverLoadConcurrency() && coverLoadQueue.length) {
        const task = coverLoadQueue.shift();
        if (!task?.img?.isConnected || task.signal?.aborted || task.img.dataset.cvCoverStarted === '1') continue;
        task.img.dataset.cvCoverStarted = '1';
        coverLoadsActive += 1;
        loadCoverNow(task.img, task.cardId, task.signal).finally(() => {
            coverLoadsActive = Math.max(0, coverLoadsActive - 1);
            pumpCoverQueue();
        });
    }
}

function enqueueCoverLoad(img, cardId, signal) {
    if (!img?.isConnected || img.dataset.cvCoverStarted === '1') return;
    coverLoadQueue.push({ img, cardId, signal });
    pumpCoverQueue();
}

function bindLazyCoverLoading(root = document, reset = true) {
    if (reset) {
        coverIntersectionObserver?.disconnect();
        coverIntersectionObserver = null;
        coverLoadQueue = [];
    }
    const body = document.querySelector('#cv_library_body');
    const images = [...(root.querySelectorAll?.('img[data-cv-cover-id]') || [])]
        .filter(img => img.dataset.cvCoverObserved !== '1' && img.dataset.cvCoverStarted !== '1');
    if (!images.length) return;

    if (typeof IntersectionObserver !== 'function') {
        images.forEach(img => {
            img.dataset.cvCoverObserved = '1';
            enqueueCoverLoad(img, img.dataset.cvCoverId || '', overlayAbortController?.signal);
        });
        return;
    }

    if (!coverIntersectionObserver) {
        coverIntersectionObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                coverIntersectionObserver?.unobserve(img);
                enqueueCoverLoad(img, img.dataset.cvCoverId || '', overlayAbortController?.signal);
            }
        }, { root: body || null, rootMargin: shouldUseMobileLibrary() ? '650px 0px' : '180px 0px', threshold: 0.01 });
    }
    images.forEach(img => {
        img.dataset.cvCoverObserved = '1';
        coverIntersectionObserver.observe(img);
    });
}

function copyLibraryViewState(mode) {
    const state = libraryViewState[mode === 'play' ? 'play' : 'cards'];
    return { ...state };
}

function captureLibraryPosition(itemId = '') {
    const body = document.querySelector('#cv_library_body');
    if (!body) return copyLibraryViewState(currentLibraryMode);
    const state = libraryViewState[currentLibraryMode];
    state.query = currentLibraryQuery;
    state.scrollTop = Math.max(0, Number(body.scrollTop || 0));
    if (currentLibraryMode === 'cards') state.category = currentAiCategoryFilter;
    state.anchorId = String(itemId || '');
    state.anchorOffset = 0;
    if (state.anchorId) {
        const article = [...body.querySelectorAll('.cv-card')].find(node => {
            const id = node.dataset.cardId || node.dataset.archiveId || '';
            return String(id) === state.anchorId;
        });
        if (article) state.anchorOffset = Number(article.offsetTop || 0) - state.scrollTop;
    }
    return copyLibraryViewState(currentLibraryMode);
}

function restoreLibraryPosition(mode, state) {
    const body = document.querySelector('#cv_library_body');
    if (!body || !state) return;
    const apply = () => {
        const article = state.anchorId
            ? [...body.querySelectorAll('.cv-card')].find(node => String(node.dataset.cardId || node.dataset.archiveId || '') === String(state.anchorId))
            : null;
        const target = article
            ? Math.max(0, Number(article.offsetTop || 0) - Number(state.anchorOffset || 0))
            : Math.max(0, Number(state.scrollTop || 0));
        body.scrollTop = target;
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
        apply();
        setTimeout(apply, 60);
        setTimeout(apply, 180);
    }));
}

async function returnToLibrary(mode, state) {
    const normalized = mode === 'play' ? 'play' : 'cards';
    const restore = { ...libraryViewState[normalized], ...(state || {}) };
    libraryViewState[normalized] = { ...restore };
    createOverlay(normalized, { preserveState: true });
    currentLibraryQuery = String(restore.query || '');
    if (normalized === 'cards') currentAiCategoryFilter = restore.category || '全部';
    const search = document.querySelector('#cv_library_search');
    if (search) search.value = currentLibraryQuery;
    paintLibraryMode();
    await loadCurrentLibrary(currentLibraryQuery);
    restoreLibraryPosition(normalized, restore);
}

function createOverlay(mode = 'cards', options = {}) {
    globalThis.VVVUnifiedCore?.overlays?.activate?.('cardvault');
    closeOverlay();
    overlayAbortController = new AbortController();
    selectionMode = false;
    selectedCardIds.clear();
    loadedCards = [];
    visibleCards = [];
    visiblePlayArchives = [];
    currentLibraryMode = mode === 'play' ? 'play' : 'cards';
    if (options.preserveState) {
        const state = libraryViewState[currentLibraryMode];
        currentLibraryQuery = String(state.query || '');
        if (currentLibraryMode === 'cards') currentAiCategoryFilter = state.category || '全部';
    } else {
        currentLibraryQuery = '';
        currentAiCategoryFilter = '全部';
        libraryViewState[currentLibraryMode] = currentLibraryMode === 'cards'
            ? { query: '', scrollTop: 0, anchorId: '', anchorOffset: 0, category: '全部' }
            : { query: '', scrollTop: 0, anchorId: '', anchorOffset: 0 };
    }

    const overlay = document.createElement('div');
    overlay.className = 'cv-overlay';
    overlay.innerHTML = `
      <section class="cv-window" role="dialog" aria-modal="true" aria-label="CardVault 云端卡库">
        <header class="cv-header cv-header-with-switch">
          <div class="cv-brand"><i class="fa-solid fa-box-archive"></i><div><b>CardVault</b><small>角色卡与游玩备份</small></div></div>
          <nav class="cv-library-switch" aria-label="CardVault 项目">
            <button class="menu_button" data-cv-mode="cards" type="button"><i class="fa-regular fa-address-card"></i><span>角色卡库</span></button>
            <button class="menu_button" data-cv-mode="play" type="button"><i class="fa-solid fa-gamepad"></i><span>游玩备份</span></button>
          </nav>
          <div class="cv-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input id="cv_library_search" class="text_pole" placeholder="搜索角色、作者或标签"></div>
          <button id="cv_ai_classify" class="menu_button cv-ai-classify-button" type="button" title="只分类新增 / 未分类角色卡；已分类卡不会重复调用"><i class="fa-solid fa-wand-magic-sparkles"></i><span>AI分类</span></button>
          <button id="cv_ai_retry_failed" class="menu_button cv-ai-retry-button" type="button" hidden title="只重新尝试上一次失败的角色卡"><i class="fa-solid fa-rotate-right"></i><span>重试失败</span></button>
          <button id="cv_library_manage" class="menu_button cv-manage-button" type="button" title="批量管理"><i class="fa-solid fa-list-check"></i><span>批量管理</span></button>
          <button id="cv_library_upload" class="menu_button" type="button"><i class="fa-solid fa-cloud-arrow-up"></i><span>上传</span></button>
          <button id="cv_library_refresh" class="menu_button" type="button" title="刷新"><i class="fa-solid fa-rotate"></i></button>
          <button id="cv_library_close" class="menu_button cv-close" type="button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <main id="cv_library_body" class="cv-library-body"><div class="cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取卡库……</div></main>
        <footer id="cv_bulk_bar" class="cv-bulk-bar" hidden>
          <div class="cv-bulk-count"><i class="fa-solid fa-circle-check"></i><span>已选择 <b id="cv_selected_count">0</b> 项</span></div>
          <div class="cv-bulk-actions">
            <button id="cv_select_all" class="menu_button" type="button"><i class="fa-solid fa-check-double"></i> 全选当前结果</button>
            <button id="cv_invert_selection" class="menu_button" type="button"><i class="fa-solid fa-arrow-right-arrow-left"></i> 反选当前结果</button>
            <button id="cv_select_unrestored" class="menu_button" type="button"><i class="fa-solid fa-box-open"></i> 只选未恢复</button>
            <button id="cv_clear_selection" class="menu_button" type="button">取消选择</button>
            <button id="cv_restore_selected" class="menu_button cv-primary cv-bulk-restore" type="button" hidden disabled><i class="fa-solid fa-play"></i> 批量恢复所选</button>
            <button id="cv_pause_restore" class="menu_button" type="button" hidden disabled><i class="fa-solid fa-pause"></i> 暂停</button>
            <button id="cv_retry_restore_failed" class="menu_button" type="button" hidden disabled><i class="fa-solid fa-rotate-right"></i> 重试失败项</button>
            <button id="cv_delete_selected" class="menu_button cv-danger" type="button" disabled><i class="fa-solid fa-trash-can"></i> 删除所选</button>
          </div>
        </footer>
      </section>`;
    document.body.append(overlay);
    document.body.classList.add('cv-no-scroll');
    document.documentElement.classList.add('cv-no-scroll');
    attachMobileViewport(overlay);

    overlay.addEventListener('mousedown', event => { if (event.target === overlay) closeOverlay(); });
    overlay.querySelector('#cv_library_close').addEventListener('click', closeOverlay);
    overlay.querySelector('#cv_library_refresh').addEventListener('click', () => currentLibraryMode === 'cards' ? loadCards(overlay.querySelector('#cv_library_search').value, { force: true }) : loadCurrentLibrary(overlay.querySelector('#cv_library_search').value));
    overlay.querySelector('#cv_library_upload').addEventListener('click', () => document.querySelector('#cv_upload_input')?.click());
    overlay.querySelector('#cv_ai_classify').addEventListener('click', () => runAiClassification().catch(error => notify('error', error.message)));
    overlay.querySelector('#cv_ai_retry_failed').addEventListener('click', () => runAiClassification({ onlyFailed: true }).catch(error => notify('error', error.message)));
    overlay.querySelector('#cv_library_manage').addEventListener('click', () => setSelectionMode(!selectionMode));
    overlay.querySelector('#cv_select_all').addEventListener('click', selectAllVisible);
    overlay.querySelector('#cv_invert_selection').addEventListener('click', invertVisibleSelection);
    overlay.querySelector('#cv_select_unrestored').addEventListener('click', selectUnrestoredVisible);
    overlay.querySelector('#cv_clear_selection').addEventListener('click', clearSelection);
    overlay.querySelector('#cv_restore_selected').addEventListener('click', restoreSelectedPlayArchives);
    overlay.querySelector('#cv_pause_restore').addEventListener('click', toggleBatchRestorePause);
    overlay.querySelector('#cv_retry_restore_failed').addEventListener('click', retryFailedPlayArchives);
    overlay.querySelector('#cv_delete_selected').addEventListener('click', deleteSelectedItems);
    overlay.querySelectorAll('[data-cv-mode]').forEach(button => {
        button.addEventListener('click', () => switchLibraryMode(button.dataset.cvMode));
    });

    let timer = 0;
    const search = overlay.querySelector('#cv_library_search');
    search.value = currentLibraryQuery;
    search.addEventListener('input', event => {
        clearTimeout(timer);
        timer = setTimeout(() => currentLibraryMode === 'cards' ? loadCards(event.target.value, { localOnly: true }) : loadCurrentLibrary(event.target.value), 120);
    });

    paintLibraryMode();
    return overlay;
}

function paintLibraryMode() {
    const overlay = document.querySelector('.cv-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('[data-cv-mode]').forEach(button => button.classList.toggle('active', button.dataset.cvMode === currentLibraryMode));
    const search = overlay.querySelector('#cv_library_search');
    const manage = overlay.querySelector('#cv_library_manage');
    const upload = overlay.querySelector('#cv_library_upload');
    const aiClassify = overlay.querySelector('#cv_ai_classify');
    const aiRetry = overlay.querySelector('#cv_ai_retry_failed');
    if (search) search.placeholder = currentLibraryMode === 'play' ? '搜索游玩备份' : '搜索角色、作者或标签';
    if (manage) manage.hidden = false;
    if (upload) upload.hidden = currentLibraryMode !== 'cards';
    if (aiClassify) {
        aiClassify.hidden = currentLibraryMode !== 'cards';
        aiClassify.title = `只分类新增 / 未分类角色卡；${aiGenerationModeLabel()}；不会使用聊天主 API`;
    }
    if (aiRetry) aiRetry.hidden = currentLibraryMode !== 'cards' || lastAiFailureIds.size === 0;
    updateBulkBar();
}

async function switchLibraryMode(mode) {
    currentLibraryMode = mode === 'play' ? 'play' : 'cards';
    currentLibraryQuery = '';
    if (currentLibraryMode === 'cards') currentAiCategoryFilter = '全部';
    setSelectionMode(false);
    const search = document.querySelector('#cv_library_search');
    if (search) search.value = '';
    paintLibraryMode();
    await loadCurrentLibrary('');
}

async function loadCurrentLibrary(query = '') {
    return currentLibraryMode === 'play' ? loadPlayArchives(query) : loadCards(query);
}

function setSelectionMode(enabled) {
    selectionMode = Boolean(enabled);
    const windowEl = document.querySelector('.cv-window');
    const manageButton = document.querySelector('#cv_library_manage');
    windowEl?.classList.toggle('cv-selection-mode', selectionMode);
    if (manageButton) {
        manageButton.classList.toggle('active', selectionMode);
        manageButton.innerHTML = selectionMode
            ? '<i class="fa-solid fa-xmark"></i><span>退出选择</span>'
            : '<i class="fa-solid fa-list-check"></i><span>批量管理</span>';
    }
    if (!selectionMode) selectedCardIds.clear();
    syncCardSelectionUi();
    updateBulkBar();
}

function currentVisibleLibraryItems() {
    return currentLibraryMode === 'play' ? visiblePlayArchives : visibleCards;
}

function itemIdFromNode(article) {
    return String(article?.dataset?.cardId || article?.dataset?.archiveId || '');
}

function syncCardSelectionUi() {
    document.querySelectorAll('.cv-card[data-card-id], .cv-card[data-archive-id]').forEach(article => {
        const id = itemIdFromNode(article);
        const selected = selectedCardIds.has(id);
        article.classList.toggle('selected', selected);
        article.setAttribute('aria-selected', String(selected));
        const icon = article.querySelector('.cv-select-toggle i');
        if (icon) icon.className = selected ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle';
    });
}

function toggleCardSelection(itemId) {
    const id = String(itemId || '');
    if (!id) return;
    if (!selectionMode) setSelectionMode(true);
    if (selectedCardIds.has(id)) selectedCardIds.delete(id);
    else selectedCardIds.add(id);
    syncCardSelectionUi();
    updateBulkBar();
}

function selectAllVisible() {
    const ids = currentVisibleLibraryItems().map(item => String(item.id));
    const allSelected = ids.length > 0 && ids.every(id => selectedCardIds.has(id));
    for (const id of ids) {
        if (allSelected) selectedCardIds.delete(id);
        else selectedCardIds.add(id);
    }
    syncCardSelectionUi();
    updateBulkBar();
}

function invertVisibleSelection() {
    if (!selectionMode) setSelectionMode(true);
    for (const item of currentVisibleLibraryItems()) {
        const id=String(item.id||'');if(!id)continue;
        if(selectedCardIds.has(id))selectedCardIds.delete(id);else selectedCardIds.add(id);
    }
    syncCardSelectionUi();updateBulkBar();
}

function selectUnrestoredVisible() {
    if (!selectionMode) setSelectionMode(true);
    for(const item of currentVisibleLibraryItems()){
        const id=String(item.id||'');if(!id)continue;
        if(currentLibraryMode==='play'&&String(item.state||'')!=='active')selectedCardIds.add(id);
        else if(currentLibraryMode==='play')selectedCardIds.delete(id);
    }
    syncCardSelectionUi();updateBulkBar();
}

function toggleBatchRestorePause() {
    batchRestorePauseRequested=!batchRestorePauseRequested;
    const button=document.querySelector('#cv_pause_restore');
    if(button)button.innerHTML=batchRestorePauseRequested?'<i class="fa-solid fa-play"></i> 继续':'<i class="fa-solid fa-pause"></i> 暂停';
    if(!batchRestorePauseRequested)batchRestorePaused=false;
}

async function waitWhileBatchRestorePaused(button,index,total,name) {
    while(batchRestorePauseRequested){
        batchRestorePaused=true;
        if(button)button.innerHTML=`<i class="fa-solid fa-pause"></i> 已暂停 ${index}/${total} ${escapeHtml(name||'')}`;
        setStatus(`批量恢复已暂停：${index}/${total} ${name||''}`,'idle');
        await new Promise(resolve=>setTimeout(resolve,200));
    }
    batchRestorePaused=false;
}

async function retryFailedPlayArchives(event) {
    if(!lastBatchRestoreFailures.length)return;
    selectedCardIds=new Set(lastBatchRestoreFailures.map(row=>String(row.id)));
    setSelectionMode(true);
    await restoreSelectedPlayArchives(event);
}

function clearSelection() {
    selectedCardIds.clear();
    syncCardSelectionUi();
    updateBulkBar();
}

function updateBulkBar() {
    const bar = document.querySelector('#cv_bulk_bar');
    const count = document.querySelector('#cv_selected_count');
    const deleteButton = document.querySelector('#cv_delete_selected');
    const restoreButton = document.querySelector('#cv_restore_selected');
    const selectAllButton = document.querySelector('#cv_select_all');
    const pauseButton=document.querySelector('#cv_pause_restore');
    const retryRestoreButton=document.querySelector('#cv_retry_restore_failed');
    if (bar) bar.hidden = !selectionMode;
    if (count) count.textContent = String(selectedCardIds.size);
    if (deleteButton) deleteButton.disabled = selectedCardIds.size === 0;
    if (restoreButton) {
        restoreButton.hidden = currentLibraryMode !== 'play';
        restoreButton.disabled = selectedCardIds.size === 0 || currentLibraryMode !== 'play';
        restoreButton.title = '恢复所选游玩备份到酒馆；不限制选择数量，按顺序逐个恢复以避免并发写入冲突';
    }
    if(pauseButton){pauseButton.hidden=currentLibraryMode!=='play';pauseButton.disabled=!batchRestorePaused&&!batchRestorePauseRequested;}
    if(retryRestoreButton){retryRestoreButton.hidden=currentLibraryMode!=='play'||lastBatchRestoreFailures.length===0;retryRestoreButton.disabled=lastBatchRestoreFailures.length===0;}
    if (selectAllButton) {
        const ids = currentVisibleLibraryItems().map(item => String(item.id));
        const allSelected = ids.length > 0 && ids.every(id => selectedCardIds.has(id));
        selectAllButton.innerHTML = allSelected
            ? '<i class="fa-solid fa-minus"></i> 取消全选'
            : '<i class="fa-solid fa-check-double"></i> 全选当前结果';
    }
}

function mappedAvatarForPlayArchive(archiveId) {
    const id = String(archiveId || '');
    if (!id) return '';
    const map = extensionSettings().playArchiveMap || {};
    for (const [avatar, row] of Object.entries(map)) {
        if (String(row?.archiveId || '') === id) return String(avatar || '');
    }
    return '';
}

function chooseRestoreFilename(archive, existingCharacters = []) {
    const requested = safeFilename(archive.originalAvatarName || archive.characterOriginalName || `${archive.name || '角色'}.png`);
    const normalized = requested.toLowerCase().endsWith('.png') ? requested : `${requested}.png`;
    const used = new Set((existingCharacters || []).map(item => String(item?.avatar || '').toLowerCase()).filter(Boolean));
    if (!used.has(normalized.toLowerCase())) return normalized;
    const stem = normalized.replace(/\.png$/i, '');
    const suffix = String(archive?.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8) || Date.now().toString(36);
    let candidate = `${stem}__CV_${suffix}.png`;
    let n = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${stem}__CV_${suffix}_${n++}.png`;
    return candidate;
}

async function findActiveLocalArchiveCharacter(archive) {
    const existing = await getUniqueSillyTavernCharacters();
    const candidates = [
        String(archive?.restoredAvatar || '').trim(),
        mappedAvatarForPlayArchive(archive?.id),
    ].filter(Boolean);
    for (const avatar of candidates) {
        const index = existing.findIndex(item => String(item?.avatar || '') === avatar);
        if (index >= 0) return { character: existing[index], avatar, index, existing };
    }
    return { character: null, avatar: '', index: -1, existing };
}

async function waitForCurrentCharacterAvatar(avatar, timeoutMs = 30000) {
    const target = String(avatar || '').trim();
    if (!target) return false;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const ctx = context();
        const current = String(ctx?.characters?.[ctx?.characterId]?.avatar || ctx?.chatMetadata?.avatar || '').trim();
        if (current === target) return true;
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    return false;
}

async function restoreSelectedPlayArchives(event) {
    const queue=globalThis.VVVUnifiedCore?.tasks;
    if(queue?.run)return queue.run('CardVault批量恢复',()=>restoreSelectedPlayArchivesUnlocked(event),{group:'generation-control'});
    return restoreSelectedPlayArchivesUnlocked(event);
}

async function restoreSelectedPlayArchivesUnlocked(event) {
    if (currentLibraryMode !== 'play') return;
    const ids = [...selectedCardIds];
    if (!ids.length) return;
    const summaries = visiblePlayArchives.filter(item => selectedCardIds.has(String(item.id)));
    const names = summaries.slice(0, 5).map(item => item.name || '未命名角色').join('、');
    const extra = ids.length > 5 ? ` 等 ${ids.length} 个` : `${ids.length} 个`;
    const totalChats = summaries.reduce((sum, item) => sum + Number(item.chatCount || 0), 0);
    const approved = await cardVaultConfirm({
        title: '批量恢复游玩备份',
        message: `将 ${names ? `${names}（${extra}）` : `${ids.length} 个游玩备份`} 一次恢复到酒馆。\n\n预计恢复 ${totalChats} 个聊天记录。酒馆现有角色不会被删除；恢复数量不设上限，但会按顺序逐个执行，避免同时写入角色/聊天/世界书造成冲突。`,
        confirmText: `恢复 ${ids.length} 个`,
        cancelText: '取消',
    });
    if (!approved) return;

    const button = event?.currentTarget || document.querySelector('#cv_restore_selected');
    const original = button?.innerHTML || '<i class="fa-solid fa-play"></i> 批量恢复所选';
    let restored = 0;
    let alreadyActive = 0;
    const failed = [];
    batchRestorePauseRequested=false;batchRestorePaused=false;lastBatchRestoreFailures=[];
    const pauseButton=document.querySelector('#cv_pause_restore');if(pauseButton){pauseButton.hidden=false;pauseButton.disabled=false;pauseButton.innerHTML='<i class="fa-solid fa-pause"></i> 暂停';}
    try {
        if (button) button.disabled = true;
        for (let index = 0; index < ids.length; index += 1) {
            const id = ids[index];
            const summary = summaries.find(item => String(item.id) === String(id));
            const name = summary?.name || `备份 ${index + 1}`;
            await waitWhileBatchRestorePaused(button,index+1,ids.length,name);
            if (button) button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 恢复 ${index + 1}/${ids.length} ${escapeHtml(name)}`;
            setStatus(`批量恢复 ${index + 1}/${ids.length}：${name}`, 'loading');
            try {
                const archive = await apiFetch(`/api/play-archives/${encodeURIComponent(id)}`, { timeoutMs: 30000 });
                const result = await restorePlayArchiveToSillyTavern(archive, null, {
                    skipConfirm: true,
                    keepOverlay: true,
                    silentSuccess: true,
                    silentError: true,
                    rethrow: true,
                    _unifiedQueueHeld: true,
                });
                if (result?.alreadyActive) alreadyActive += 1;
                else restored += 1;
            } catch (error) {
                failed.push({ id, name, message: error?.message || '未知错误' });
                console.error('[CardVault] 批量恢复失败', id, error);
            }
        }
        lastBatchRestoreFailures=failed.slice();
        selectedCardIds.clear();
        const summary = `批量恢复完成：新恢复 ${restored} 个，已在酒馆 ${alreadyActive} 个，失败 ${failed.length} 个`;
        setStatus(summary, failed.length ? 'idle' : 'success');
        if (failed.length) {
            notify('warning', `${summary}。首个失败：${failed[0].name}：${failed[0].message}`);
        } else {
            notify('success', summary);
        }
        await loadPlayArchives(currentLibraryQuery);
        if (selectionMode) setSelectionMode(false);
        return { total: ids.length, restored, alreadyActive, failed };
    } finally {
        batchRestorePauseRequested=false;batchRestorePaused=false;
        if(pauseButton?.isConnected){pauseButton.hidden=true;pauseButton.disabled=true;pauseButton.innerHTML='<i class="fa-solid fa-pause"></i> 暂停';}
        if (button?.isConnected) {
            button.innerHTML = original;
            button.disabled = selectedCardIds.size === 0;
        }
        updateBulkBar();
    }
}

async function deleteSelectedItems() {
    const ids = [...selectedCardIds];
    if (!ids.length) return;
    const isPlay = currentLibraryMode === 'play';
    const items = currentVisibleLibraryItems();
    const names = items.filter(item => selectedCardIds.has(String(item.id))).map(item => item.name).filter(Boolean);
    const preview = names.slice(0, 3).join('、');
    const suffix = names.length > 3 ? ` 等 ${ids.length} 个` : `${ids.length} 个`;
    const message = isPlay
        ? `确定删除 ${preview ? `${preview}（${suffix}）` : `${ids.length} 个游玩备份`}吗？\n\n服务器会先移动到回收目录，不会立即物理清空。`
        : `确定永久删除 ${preview ? `${preview}（${suffix}）` : `${ids.length} 张角色卡`}吗？\n\n该操作无法撤销。`;
    if (!globalThis.confirm(message)) return;

    const button = document.querySelector('#cv_delete_selected');
    const original = button?.innerHTML;
    let deleted = 0;
    let failed = 0;
    try {
        if (button) button.disabled = true;
        for (const [index, id] of ids.entries()) {
            if (button) button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 删除中 ${index + 1}/${ids.length}`;
            try {
                const endpoint = isPlay ? `/api/play-archives/${encodeURIComponent(id)}` : `/api/cards/${encodeURIComponent(id)}`;
                await apiFetch(endpoint, { method: 'DELETE', timeoutMs: 30000 });
                deleted += 1;
            } catch (error) {
                failed += 1;
                console.error('[CardVault] Batch delete failed', id, error);
            }
        }
        selectedCardIds.clear();
        const noun = isPlay ? '个游玩备份' : '张角色卡';
        notify(failed ? 'warning' : 'success', failed ? `已删除 ${deleted} ${noun}，${failed} 个失败` : `已删除 ${deleted} ${noun}`);
        await loadCurrentLibrary(currentLibraryQuery);
        if (!currentVisibleLibraryItems().length) setSelectionMode(false);
    } finally {
        if (button) {
            button.innerHTML = original || '<i class="fa-solid fa-trash-can"></i> 删除所选';
            button.disabled = selectedCardIds.size === 0;
        }
        updateBulkBar();
    }
}


// CardVault 0.4.27：静默自动导入守护版（继承无启动动画）。点击卡库后直接认证、创建界面并读取卡片；不创建任何入场遮罩、iframe 或地底圣堂动画。
async function openLibrary() {
    if (!await verify({ quiet: true })) throw new Error('请先在扩展设置中登录 CardVault');
    createOverlay('cards');
    await loadCards('');
}

function classificationStorageKey(cardId) {
    return `${requiredCardVaultAccount()}:${String(cardId || '')}`;
}

function selectedAiFilters() {
    if (!currentAiCategoryFilter || currentAiCategoryFilter === '全部') return [];
    return [...new Set(String(currentAiCategoryFilter).split('||').map(value => value.trim()).filter(Boolean))];
}

function setSelectedAiFilters(tags) {
    const normalized = [...new Set((Array.isArray(tags) ? tags : []).map(String).map(value => value.trim()).filter(tag => tag === '未分类' || currentCategoryTags().includes(tag)))];
    currentAiCategoryFilter = normalized.length ? normalized.join('||') : '全部';
    libraryViewState.cards.category = currentAiCategoryFilter;
}

function aiFilterSummary() {
    const tags = selectedAiFilters();
    return tags.length ? tags.map(tag => tag === '未分类' ? tag : aiTagLabel(tag)).join('、') : '全部';
}

function classificationFingerprint(card) {
    return [card?.id, card?.currentVersion ?? card?.version ?? '', card?.size ?? '', card?.updatedAt ?? card?.updated_at ?? ''].join('|');
}

function getCardClassification(card) {
    if (!card?.id) return null;
    const record = extensionSettings().aiClassifications[classificationStorageKey(card.id)];
    if (!record || !Array.isArray(record.tags)) return null;
    if (Number(record.taxonomyVersion || 0) !== currentClassificationTaxonomyVersion()) return null;
    // 0.4.7 增量分类策略：只要同一 CardVault 账号下这个 card.id 已按当前标签体系分类过，
    // 就一直视为“已分类”。导入新卡、刷新列表、版本号/大小/updatedAt 变化都不会让旧卡自动重跑 AI。
    // fingerprint 仍保留在记录里，仅作为审计信息；只有用户主动“重新分类全部”才覆盖旧结果。
    return record;
}

function saveCardClassification(card, result) {
    const cfg = extensionSettings();
    const tags = [...new Set((Array.isArray(result?.tags) ? result.tags : []).map(value => String(value).trim()).filter(tag => currentCategoryTags().includes(tag)))].slice(0, 7);
    if (!tags.length) throw new Error('AI 没有返回有效的类脑标签');
    cfg.aiClassifications[classificationStorageKey(card.id)] = {
        tags,
        summary: String(result?.summary || '').trim().slice(0, 120),
        confidence: Number.isFinite(Number(result?.confidence)) ? Math.max(0, Math.min(1, Number(result.confidence))) : null,
        taxonomyVersion: currentClassificationTaxonomyVersion(),
        fingerprint: classificationFingerprint(card),
        classifiedAt: new Date().toISOString(),
    };
    saveSettings();
    return cfg.aiClassifications[classificationStorageKey(card.id)];
}

function cardMatchesAiFilter(card) {
    const selected = selectedAiFilters();
    if (!selected.length) return true;
    const record = getCardClassification(card);
    return selected.some(tag => tag === '未分类' ? !record : Boolean(record?.tags?.includes(tag)));
}

function aiTagBadgesHtml(card) {
    const record = getCardClassification(card);
    if (!record?.tags?.length) return '';
    return `<div class="cv-ai-card-tags cv-ai-card-tags-overlay" data-cv-ai-autofit="1" title="${escapeHtml(record.tags.map(aiTagLabel).join(' · '))}">${record.tags.map((tag, index) => `<span class="cv-ai-tag" data-cv-ai-tag-index="${index}">${escapeHtml(aiTagLabel(tag))}</span>`).join('')}<span class="cv-ai-more" hidden></span></div>`;
}

function fitAiTagBadgeRow(container) {
    if (!container?.isConnected) return;
    const tags = [...container.querySelectorAll('.cv-ai-tag')];
    const more = container.querySelector('.cv-ai-more');
    if (!tags.length || !more) return;

    // 先恢复真实宽度再测量：可见标签绝不省略文字，放不下的才折叠到 +N。
    tags.forEach(tag => {
        tag.style.display = 'inline-flex';
        tag.style.visibility = 'hidden';
    });
    more.hidden = false;
    more.style.display = 'inline-flex';
    more.style.visibility = 'hidden';

    const available = Math.floor(container.clientWidth);
    if (available <= 0) {
        tags.forEach(tag => { tag.style.visibility = ''; });
        more.style.visibility = '';
        return;
    }

    const style = getComputedStyle(container);
    const gap = Number.parseFloat(style.columnGap || style.gap || '0') || 0;
    const widths = tags.map(tag => Math.ceil(tag.getBoundingClientRect().width));
    const prefix = [0];
    for (const width of widths) prefix.push(prefix[prefix.length - 1] + width);

    let keep = tags.length;
    for (; keep >= 0; keep -= 1) {
        const hiddenCount = tags.length - keep;
        let total = prefix[keep] + Math.max(0, keep - 1) * gap;
        if (hiddenCount > 0) {
            more.textContent = `+${hiddenCount}`;
            const moreWidth = Math.ceil(more.getBoundingClientRect().width);
            total += moreWidth + (keep > 0 ? gap : 0);
        }
        if (total <= available + 1) break;
    }
    keep = Math.max(0, keep);

    tags.forEach((tag, index) => {
        const shown = index < keep;
        tag.style.display = shown ? 'inline-flex' : 'none';
        tag.style.visibility = '';
    });

    const hiddenCount = tags.length - keep;
    if (hiddenCount > 0) {
        more.textContent = `+${hiddenCount}`;
        more.hidden = false;
        more.style.display = 'inline-flex';
        more.style.visibility = '';
    } else {
        more.hidden = true;
        more.style.display = 'none';
        more.style.visibility = '';
    }
}

function layoutAiTagBadgeRows(root = document) {
    const rows = [...(root.querySelectorAll?.('[data-cv-ai-autofit="1"]') || [])];
    if (!rows.length) return;
    let cursor = 0;
    const batchLimit = shouldUseMobileLibrary() ? 12 : 4;
    const step = deadline => {
        let count = 0;
        while (cursor < rows.length && count < batchLimit && (!deadline || deadline.timeRemaining() > 2)) {
            const row = rows[cursor++];
            if (row?.isConnected) fitAiTagBadgeRow(row);
            count += 1;
        }
        if (cursor < rows.length) {
            if (typeof requestIdleCallback === 'function') requestIdleCallback(step, { timeout: shouldUseMobileLibrary() ? 120 : 260 });
            else requestAnimationFrame(() => step(null));
        }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(step, { timeout: shouldUseMobileLibrary() ? 120 : 260 });
    else requestAnimationFrame(() => step(null));
}

function scheduleAiTagBadgeLayout(root = document) {
    if (aiTagFitRaf) cancelAnimationFrame(aiTagFitRaf);
    aiTagFitRaf = requestAnimationFrame(() => {
        aiTagFitRaf = 0;
        layoutAiTagBadgeRows(root);
    });
}

function bindAiTagBadgeAutoFit(root = document) {
    if (typeof ResizeObserver === 'function') {
        if (!aiTagFitResizeObserver) {
            aiTagFitResizeObserver = new ResizeObserver(() => scheduleAiTagBadgeLayout(root));
        } else {
            aiTagFitResizeObserver.disconnect();
        }
        aiTagFitResizeObserver.observe(root);
    }
    if (!aiTagFitResizeBound) {
        aiTagFitResizeBound = true;
        window.addEventListener('resize', () => scheduleAiTagBadgeLayout(document), { passive: true });
        if (document.fonts?.ready) document.fonts.ready.then(() => scheduleAiTagBadgeLayout(document)).catch(() => {});
    }
    scheduleAiTagBadgeLayout(root);
}

function closeAiFilterPicker() {
    document.querySelector('.cv-ai-picker-backdrop')?.remove();
}

function openAiFilterPicker(cards) {
    closeAiFilterPicker();
    const win = document.querySelector('.cv-window');
    if (!win) return;
    const selected = new Set(selectedAiFilters());
    const classifiedCount = cards.filter(card => getCardClassification(card)).length;
    const backdrop = document.createElement('div');
    backdrop.className = 'cv-ai-picker-backdrop';
    backdrop.innerHTML = `
      <section class="cv-ai-picker" role="dialog" aria-modal="true" aria-label="选择 AI 分类标签">
        <div class="cv-ai-picker-heading">
          <div><b>选择标签</b><span id="cv_ai_pick_count">${selected.size}</span></div>
          <button class="menu_button cv-ai-picker-close" type="button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="cv-ai-picker-note">${escapeHtml(classificationTaxonomy().name)} · ${escapeHtml(aiGenerationModeLabel())} · ${classifiedCount}/${cards.length} 已分类 · 可多选</div>
        <div class="cv-ai-picker-chips">
          ${[...currentCategoryTags(), '未分类'].map(tag => `<button class="menu_button ${selected.has(tag) ? 'active' : ''}" type="button" data-cv-ai-pick="${escapeHtml(tag)}">${escapeHtml(tag === '未分类' ? tag : aiTagLabel(tag))}</button>`).join('')}
        </div>
        <div class="cv-ai-picker-footer">
          <button id="cv_ai_clear_filters" class="menu_button cv-ai-clear-filter" type="button">全部清除</button>
          <button id="cv_ai_reclassify_all" class="menu_button cv-ai-reclassify-all" type="button" title="手动重新调用 AI 分类当前列表中的全部角色卡"><i class="fa-solid fa-arrows-rotate"></i> 重新分类全部</button>
        </div>
      </section>`;
    const sync = () => {
        backdrop.querySelector('#cv_ai_pick_count').textContent = String(selected.size);
        backdrop.querySelectorAll('[data-cv-ai-pick]').forEach(button => button.classList.toggle('active', selected.has(button.dataset.cvAiPick || '')));
        setSelectedAiFilters([...selected]);
        clearSelection();
        renderLoadedCards();
        const body = document.querySelector('#cv_library_body');
        if (body) body.scrollTop = 0;
    };
    backdrop.querySelectorAll('[data-cv-ai-pick]').forEach(button => button.addEventListener('click', event => {
        event.preventDefault();
        const tag = button.dataset.cvAiPick || '';
        if (!tag) return;
        if (selected.has(tag)) selected.delete(tag); else selected.add(tag);
        sync();
    }));
    backdrop.querySelector('#cv_ai_clear_filters').addEventListener('click', () => { selected.clear(); sync(); });
    backdrop.querySelector('#cv_ai_reclassify_all').addEventListener('click', () => {
        closeAiFilterPicker();
        runAiClassification({ forceAll: true }).catch(error => notify('error', error.message));
    });
    backdrop.querySelector('.cv-ai-picker-close').addEventListener('click', closeAiFilterPicker);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) closeAiFilterPicker(); });
    win.append(backdrop);
}

function buildAiFilterBar(cards) {
    const selected = selectedAiFilters();
    const classified = cards.filter(card => getCardClassification(card));
    const bar = document.createElement('div');
    bar.className = 'cv-ai-filter-bar';
    bar.innerHTML = `
      <button id="cv_ai_filter_open" class="menu_button cv-ai-filter-open ${selected.length ? 'active' : ''}" type="button">
        <i class="fa-solid fa-tags"></i><span>选择标签</span><b>${selected.length}</b>
      </button>
      <div class="cv-ai-api-badge" title="AI 分类只走 CardVault 独立 API，不读取或占用聊天主 API">
        <i class="fa-solid fa-plug-circle-check"></i><span>独立 API</span><small>${escapeHtml(classifierConfig().classifierModel || '未选模型')}</small>
      </div>
      <div class="cv-ai-filter-current">${selected.length ? selected.slice(0, 4).map(tag => `<span>${escapeHtml(tag === '未分类' ? tag : aiTagLabel(tag))}</span>`).join('') + (selected.length > 4 ? `<span>+${selected.length - 4}</span>` : '') : `<small data-cv-ai-status>${classified.length}/${cards.length} 已分类 · ${escapeHtml(aiGenerationModeLabel())}</small>`}</div>`;
    bar.querySelector('#cv_ai_filter_open').addEventListener('click', () => openAiFilterPicker(cards));
    return bar;
}

function worldbookTextForAi(book) {
    if (!book) return '（无内嵌世界书）';
    const entries = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
    return entries.map((entry, index) => {
        const keys = Array.isArray(entry.keys) ? entry.keys : (Array.isArray(entry.key) ? entry.key : []);
        return `【世界书条目 ${index + 1}：${entry.comment || entry.name || '未命名'}】\n关键词：${keys.join(', ')}\n${entry.content || ''}`;
    }).join('\n\n');
}

function regexTextForAi(list) {
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) return '（无 Scoped Regex）';
    return rows.slice(0, 30).map((rule, index) => {
        const replacement = String(rule?.replaceString || '');
        return `【正则 ${index + 1}：${rule?.scriptName || rule?.name || '未命名'}】\n查找：${String(rule?.findRegex || '').slice(0, 900)}\n替换：${replacement.slice(0, 2400)}`;
    }).join('\n\n');
}

function compactExtensionsForAi(data) {
    const extensions = data?.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    try {
        const raw = JSON.stringify(extensions);
        return raw.length > 9000 ? `${raw.slice(0, 9000)}\n[扩展数据已截断]` : raw;
    } catch {
        return '（扩展数据无法序列化）';
    }
}

function cleanClassifierSnippet(value, limit = 2200) {
    let text = String(value || '');
    text = text
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]{1,500}>/g, ' ')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, Math.max(120, Number(limit) || 2200));
}

function structuralClassifierHints(card) {
    const data = valueFromCard(card);
    const regex = Array.isArray(card?.regex) ? card.regex : [];
    const worldEntries = Array.isArray(card?.worldbook?.entries) ? card.worldbook.entries : [];
    const extKeys = data?.extensions && typeof data.extensions === 'object' ? Object.keys(data.extensions).slice(0, 40) : [];
    const regexNames = regex.slice(0, 18).map(item => item?.scriptName || item?.name || '').filter(Boolean);
    const worldKeys = worldEntries.slice(0, 30).flatMap(entry => Array.isArray(entry?.keys) ? entry.keys.slice(0, 3) : []).filter(Boolean);
    return [
        `Scoped Regex 数量：${regex.length}`,
        `Regex 名称：${regexNames.join('、') || '无'}`,
        `世界书条目数：${worldEntries.length}`,
        `世界书关键词：${worldKeys.join('、') || '无'}`,
        `扩展字段：${extKeys.join('、') || '无'}`,
    ].join('\n');
}

function classificationMaterialCompact(card, maxChars = 14000) {
    const data = valueFromCard(card);
    const originalTags = Array.isArray(card.tags) ? card.tags.join('、') : '';
    const raw = [
        `角色名：${cleanClassifierSnippet(card.name || data.name || '', 240)}`,
        `作者：${cleanClassifierSnippet(card.creator || data.creator || '', 180)}`,
        `原标签：${cleanClassifierSnippet(originalTags, 800)}`,
        `角色描述摘要：${cleanClassifierSnippet(data.description, 3600)}`,
        `性格摘要：${cleanClassifierSnippet(data.personality, 1800)}`,
        `场景摘要：${cleanClassifierSnippet(data.scenario, 2200)}`,
        `首条消息摘要：${cleanClassifierSnippet(data.first_mes, 2200)}`,
        `创作者备注摘要：${cleanClassifierSnippet(data.creator_notes, 1000)}`,
        `结构信号：\n${structuralClassifierHints(card)}`,
    ].join('\n\n');
    const safeMax = Math.max(4500, Number(maxChars) || 14000);
    return raw.length > safeMax ? `${raw.slice(0, safeMax)}\n\n[精简资料已截断]` : raw;
}

function classificationMaterialMinimal(card, maxChars = 6500) {
    const data = valueFromCard(card);
    const originalTags = Array.isArray(card.tags) ? card.tags.join('、') : '';
    const raw = [
        `角色名：${cleanClassifierSnippet(card.name || data.name || '', 240)}`,
        `原标签：${cleanClassifierSnippet(originalTags, 900)}`,
        `描述关键词上下文：${cleanClassifierSnippet(data.description, 1500)}`,
        `场景关键词上下文：${cleanClassifierSnippet(data.scenario, 1200)}`,
        `创作者备注：${cleanClassifierSnippet(data.creator_notes, 700)}`,
        `结构信号：\n${structuralClassifierHints(card)}`,
    ].join('\n\n');
    const safeMax = Math.max(3200, Number(maxChars) || 6500);
    return raw.length > safeMax ? `${raw.slice(0, safeMax)}\n[最小资料已截断]` : raw;
}

function classificationMaterial(card, maxChars = 52000) {
    const data = valueFromCard(card);
    const originalTags = Array.isArray(card.tags) ? card.tags.join('、') : '';
    const alternateGreetings = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.slice(0, 6).join('\n\n--- 备选开场 ---\n') : '';
    const raw = [
        `角色名：${card.name || data.name || ''}`,
        `作者：${card.creator || data.creator || ''}`,
        `原标签：${originalTags}`,
        `角色描述：\n${data.description || ''}`,
        `性格：\n${data.personality || ''}`,
        `场景：\n${data.scenario || ''}`,
        `首条消息：\n${data.first_mes || ''}`,
        `备选开场：\n${alternateGreetings}`,
        `示例对话：\n${data.mes_example || ''}`,
        `创作者备注：\n${data.creator_notes || ''}`,
        `系统提示：\n${data.system_prompt || ''}`,
        `后历史指令：\n${data.post_history_instructions || ''}`,
        `内嵌世界书：\n${worldbookTextForAi(card.worldbook)}`,
        `Scoped Regex（用于判断纯文字/前端美化/轻重前端等）：\n${regexTextForAi(card.regex)}`,
        `角色卡扩展字段（用于判断前端、系统与世界观等）：\n${compactExtensionsForAi(data)}`,
    ].join('\n\n');
    const safeMax = Math.max(6000, Number(maxChars) || 52000);
    return raw.length > safeMax ? `${raw.slice(0, safeMax)}\n\n[资料过长，已在 ${safeMax} 字符处截断]` : raw;
}

function normalizeClassifierJsonText(value) {
    return String(value || '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u200B-\u200D\u2060]/g, '')
        .trim()
        .replace(/^```(?:json|javascript|js)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
}

function escapeRawControlCharsInsideJsonStrings(value) {
    const source = String(value || '');
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (!inString) {
            out += ch;
            if (ch === '"') inString = true;
            continue;
        }
        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            out += ch;
            escaped = true;
            continue;
        }
        if (ch === '"') {
            out += ch;
            inString = false;
            continue;
        }
        const code = ch.charCodeAt(0);
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
        else out += ch;
    }
    return out;
}

function classifierJsonCandidates(text) {
    const source = normalizeClassifierJsonText(text);
    const candidates = [];
    const push = candidate => {
        const value = String(candidate || '').trim();
        if (value && !candidates.includes(value)) candidates.push(value);
    };
    push(source);
    const firstBrace = source.indexOf('{');
    const lastBrace = source.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) push(source.slice(firstBrace, lastBrace + 1));
    if (firstBrace >= 0) push(source.slice(firstBrace));
    return candidates;
}

function tryParseClassifierJsonText(value) {
    const attempts = [String(value || '')];
    attempts.push(escapeRawControlCharsInsideJsonStrings(attempts[0]));
    attempts.push(attempts[1].replace(/,\s*([}\]])/g, '$1'));
    for (const candidate of attempts) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch { /* try next repair */ }
    }
    return null;
}

function decodeClassifierJsonStringBody(value) {
    const body = String(value || '');
    try { return JSON.parse(`"${body}"`); } catch { return body.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
}

function salvageAiClassificationResult(value) {
    const text = normalizeClassifierJsonText(value);
    const tagsMatch = text.match(/["'“”]?tags["'“”]?\s*:\s*\[([\s\S]*?)\]/i);
    if (!tagsMatch) return null;

    let tags = [];
    const tagBody = tagsMatch[1].trim();
    try {
        const parsedTags = JSON.parse(`[${escapeRawControlCharsInsideJsonStrings(tagBody)}]`);
        if (Array.isArray(parsedTags)) tags = parsedTags.map(item => String(item).trim()).filter(Boolean);
    } catch {
        tags = tagBody
            .split(/[,，]/)
            .map(item => item.trim().replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, ''))
            .filter(Boolean);
    }
    if (!tags.length) return null;

    let summary = '';
    const completeSummary = text.match(/["'“”]?summary["'“”]?\s*:\s*"((?:\\.|[^"\\])*)"/i);
    if (completeSummary) {
        summary = decodeClassifierJsonStringBody(completeSummary[1]);
    } else {
        const summaryKey = text.search(/["'“”]?summary["'“”]?\s*:/i);
        if (summaryKey >= 0) {
            const afterKey = text.slice(summaryKey).replace(/^[\s\S]*?["'“”]?summary["'“”]?\s*:\s*/i, '');
            let rawSummary = afterKey.replace(/^"/, '');
            const confidenceIndex = rawSummary.search(/"?\s*,\s*["'“”]?confidence["'“”]?\s*:/i);
            if (confidenceIndex >= 0) rawSummary = rawSummary.slice(0, confidenceIndex);
            rawSummary = rawSummary.replace(/[\s"'}，,]+$/g, '').trim();
            summary = rawSummary.replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"');
        }
    }
    if (!summary) summary = 'AI 已返回可用分类标签；说明字段格式不完整，CardVault 已自动容错保存。';

    const confidenceMatch = text.match(/["'“”]?confidence["'“”]?\s*:\s*(-?\d+(?:\.\d+)?)/i);
    const confidence = confidenceMatch ? Number(confidenceMatch[1]) : 0.5;
    return { tags, summary, confidence, _cardvaultRecovered: true };
}

function parseAiClassificationResult(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    const text = normalizeClassifierJsonText(value);
    if (!text || text === '{}') throw new Error('AI 返回为空或结构化输出不受当前模型支持');
    for (const candidate of classifierJsonCandidates(text)) {
        const parsed = tryParseClassifierJsonText(candidate);
        if (parsed) return parsed;
    }
    const recovered = salvageAiClassificationResult(text);
    if (recovered) {
        console.warn('[CardVault] AI 分类 JSON 非标准，已容错提取可用字段', recovered, text.slice(0, 500));
        return recovered;
    }
    throw new Error(`AI 没有返回可解析的分类 JSON：${text.slice(0, 220) || '空响应'}`);
}

function validateAiClassificationResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('AI 分类结果不是 JSON 对象');
    const tags = [...new Set((Array.isArray(result.tags) ? result.tags : []).map(value => String(value).trim()).filter(tag => currentCategoryTags().includes(tag)))];
    if (tags.length < 1) throw new Error(`AI 返回的标签不在当前“${classificationTaxonomy().name}”词库中`);
    return {
        ...result,
        tags: tags.slice(0, 7),
        summary: String(result.summary || '').trim().slice(0, 120),
        confidence: Number.isFinite(Number(result.confidence)) ? Math.max(0, Math.min(1, Number(result.confidence))) : 0.5,
    };
}

function aiGenerationModeLabel() {
    return classifierApiSummary();
}

function classifierRules() {
    const xRules = `1. 返回 2-7 个最有检索价值的标签，没有充分依据不要猜。
2. 【纯文字 / 轻前端 / 重前端】三者必须且只能选一个：
   - 纯文字：主要依靠文字与普通世界书游玩，没有明显 HTML/CSS/JS 界面或复杂正则前端。
   - 轻前端：有状态栏、简单 HTML/CSS、少量可视化正则或轻量交互，但不是大型网页式界面。
   - 重前端：大量 HTML/CSS/JS、复杂交互页面、多个 UI 面板/应用模拟器，前端明显是主要玩法组成。
3. 纯爱：核心关系强调专一恋爱、陪伴或双向感情；若核心是背叛/NTR，不要仅因存在感情就标纯爱。
4. NTR：核心视角存在伴侣被第三者夺走、背叛、被绿等主题。
5. NTL：核心视角更偏主动介入、夺取他人伴侣/关系的“寝取方”主题；和 NTR 区分，不确定就不要标。
6. 多路线：卡内明确存在可选对象、分支线路、多结局或多种攻略路径。
7. 伪娘/男娘：核心角色或主要可攻略对象明确属于该设定。
8. 御姐/人妻/熟女/母系：主要卖点明确涉及成熟年上女性、人妻、熟女、母亲/母系角色。
9. 幻想：奇幻、西幻、超自然、魔法、异世界、神怪等幻想题材。
10. 病娇/黑化/恶堕：核心人物或路线明确包含病娇、黑化、堕落/恶堕。
11. 人外：主要角色包含非人类、异种、怪物、兽人、机器人等非普通人类存在。
12. 乱伦：资料明确存在亲属/家庭成员之间的恋爱或性关系。
13. 系统流：存在任务系统、数值面板、签到、攻略系统、模拟经营系统等“系统”作为核心机制。
14. 同人/二创：明确基于已有作品、IP、游戏、动漫、小说角色或世界观进行二次创作。
15. 群像/多角色/后宫：主要互动对象明显不止一人，或卡的核心就是群像、多角色、后宫。
16. 女性视角：玩家/user 的主要默认视角明确为女性。
17. 百合：核心恋爱/性关系为女性与女性。
18. 现代：主要背景为现代/当代都市、校园、职场、家庭等现实时代。
19. 古风：主要背景为中国古代、架空古代、宫廷、江湖、古风东方社会。
20. summary 用一句中文概括为什么这样分类，最多 80 字。`;
    const dogRules = `1. 返回 2-7 个最有检索价值的标签，没有充分依据不要猜；允许同一张卡同时出现多个关系向标签，例如资料明确支持 BG 与 BL 时可同时选择。
2. 【BG / GB / BL / GL】按角色卡明确支持的主要关系/玩家视角判断：
   - BG：男性角色与女性玩家/女性主角为主要异性关系向。
   - GB：女性角色与男性玩家/男性主角为主要异性关系向；若卡本身明确以“女攻男受/女性主导”作为 GB 定义，也可据此标记。
   - BL：男性与男性关系向。
   - GL：女性与女性关系向。
   不明确玩家性别或关系方向时不要硬猜。
3. 【古代 / 现代 / 架空 / 未来】按时代与世界结构判断，可在确有必要时组合：
   - 古代：历史古代、古风王朝、宫廷、江湖等。
   - 现代：当代都市、校园、职场、现代家庭等。
   - 架空：虚构国家、虚构时代、与现实历史明显不同的架空世界。
   - 未来：未来社会、星际时代、未来科技文明等。
4. 奇幻：魔法、神怪、异世界、超自然、玄幻/西幻等为重要设定。
5. 科幻：科技、赛博、星际、人工智能、宇宙、硬/软科幻为重要设定。
6. 西方：主要文化与社会背景明显为欧美/西式世界、西方历史或西式幻想。
7. 同人：明确基于已有动漫、游戏、小说、影视、真人作品/IP/角色进行二创。
8. 【纯文字 / 前端美化】二者原则上选其一：
   - 纯文字：主要靠文字、普通世界书和对话游玩，没有明显状态栏、HTML/CSS UI、网页组件或视觉化正则。
   - 前端美化：存在状态栏、HTML/CSS、视觉化正则、应用/网页模拟器、复杂 UI 或明显前端展示。轻量和重度都统一归到“前端美化”。
9. ABO：Alpha/Beta/Omega、信息素、发情期、腺体等 ABO 世界观是明确设定。
10. 向哨：哨兵/向导、精神体、精神图景、结合热等 Sentinel/Guide 体系是明确设定。
11. 纯净：整体主打清水、日常、剧情或恋爱，资料中没有明显成人性行为、重口玩法或强烈 NSFW 作为核心卖点；有明确成人内容时不要标“纯净”。
12. 人外：核心角色/主要互动对象包含兽人、异种、怪物、妖怪、机器人、非人生命等。
13. 多人：同一张卡/同一故事内有多个主要可互动角色或多人关系，是主要玩法之一。
14. 合集：一张卡明显打包多个相对独立的角色、场景、短篇或可切换作品集合；不要把普通多人卡误标为合集。
15. summary 用一句中文概括为什么这样分类，最多 80 字。`;
    return requiredCardVaultAccount() === 'admin' ? dogRules : xRules;
}

function classifierFallbackModels(preferredModel = '') {
    const cfg = classifierConfig();
    const available = Array.isArray(cfg.classifierModels) ? cfg.classifierModels : [];
    const preferred = String(preferredModel || cfg.classifierModel || '').trim();
    const ranks = [
        preferred,
        'gemini-3.1-pro-preview',
        'gemini-3.1-pro-preview-low',
        'gemini-3-flash-preview',
        'gemini-2.5-pro',
        'gcli-gemini-3.1-pro-preview-nothinking',
        'gcli-gemini-3.1-pro-preview',
        'gcli-gemini-3-flash-preview-nothinking',
        '【ant】gemini-3.1-pro-high',
        '[ant] gemini-3.1-pro-high',
        '【ant】gemini-3.6-flash-high',
        '[ant] gemini-3.6-flash-high',
    ].filter(Boolean);
    if (!available.length) return preferred ? [preferred] : [];
    const out = [];
    const push = model => { if (model && !out.includes(model) && available.includes(model)) out.push(model); };
    ranks.forEach(push);
    available.filter(model => /gemini/i.test(model)).forEach(push);
    return out;
}

function localHeuristicClassification(card) {
    const taxonomy = classificationTaxonomy();
    const allowed = new Set(currentCategoryTags());
    const data = valueFromCard(card);
    let raw = '';
    try {
        raw = [
            card?.name, card?.creator, ...(Array.isArray(card?.tags) ? card.tags : []),
            data?.description, data?.personality, data?.scenario, data?.first_mes, data?.creator_notes,
            structuralClassifierHints(card),
        ].filter(Boolean).join('\n').toLowerCase();
    } catch { raw = String(card?.name || '').toLowerCase(); }
    const tags = [];
    const add = tag => { if (allowed.has(tag) && !tags.includes(tag)) tags.push(tag); };
    const has = pattern => pattern.test(raw);

    const dataString = `${String(data?.description || '')} ${String(data?.first_mes || '')} ${String(data?.creator_notes || '')}`;
    const regexCount = Array.isArray(card?.regex) ? card.regex.length : 0;
    const frontendSignals = (dataString.match(/<(?:div|style|script|button|details|summary|iframe|svg|canvas)\b|css|javascript|jquery|状态栏|前端|界面/gi) || []).length + regexCount;

    if (taxonomy.name === 'x 分类') {
        if (frontendSignals >= 10) add('重前端');
        else if (frontendSignals >= 2) add('轻前端');
        else add('纯文字');
        if (has(/妻子|人妻|熟妇|熟女|母亲|妈妈|岳母|继母|阿姨|姐姐|御姐/)) add('御姐/人妻/熟女/母系');
        if (has(/\bntr\b|牛头人|被绿|出轨|背叛|寝取られ/)) add('NTR');
        if (has(/\bntl\b|寝取|夺妻|抢走.*(?:妻|女友|伴侣)/)) add('NTL');
        if (has(/多路线|多结局|可攻略|路线选择|分支剧情/)) add('多路线');
        if (has(/后宫|群像|多人|多个角色|多角色|群聊/)) add('群像/多角色/后宫');
        if (has(/系统流|任务系统|攻略系统|签到系统|数值面板|属性面板/)) add('系统流');
        if (has(/魔法|异世界|玄幻|仙侠|妖怪|神怪|奇幻|精灵|恶魔|龙族/)) add('幻想');
        if (has(/病娇|黑化|恶堕|堕落/)) add('病娇/黑化/恶堕');
        if (has(/兽人|人外|怪物|异种|机器人|非人/)) add('人外');
        if (has(/乱伦|母子|父女|父子|兄妹|姐弟|姐妹.*恋|兄弟.*恋/)) add('乱伦');
        if (has(/同人|二创|原作|动漫|游戏原作|影视原作/)) add('同人/二创');
        if (has(/百合|女同|女性与女性|gl\b/)) add('百合');
        if (has(/女性视角|女主视角|user.*女|玩家.*女/)) add('女性视角');
        if (has(/古代|古风|王朝|宫廷|江湖|皇帝|皇后|王爷|侯府/)) add('古风');
        else if (has(/现代|当代|校园|大学|高中|公司|都市|微信|手机|汽车|公寓|妻子|职场/)) add('现代');
        if (!tags.includes('NTR') && !tags.includes('NTL') && has(/纯爱|恋爱|爱人|夫妻|妻子|女友|男友|伴侣|相爱/)) add('纯爱');
    } else {
        if (frontendSignals >= 2) add('前端美化'); else add('纯文字');
        if (has(/古代|古风|王朝|宫廷|江湖/)) add('古代');
        if (has(/现代|当代|校园|都市|职场|手机|微信|妻子/)) add('现代');
        if (has(/架空|虚构国家|虚构时代/)) add('架空');
        if (has(/未来|星际|赛博|宇宙时代/)) add('未来');
        if (has(/魔法|异世界|玄幻|仙侠|奇幻|神怪/)) add('奇幻');
        if (has(/科幻|星际|赛博|人工智能|机器人|宇宙/)) add('科幻');
        if (has(/同人|二创|原作|动漫|游戏原作/)) add('同人');
        if (has(/兽人|人外|怪物|异种|机器人/)) add('人外');
        if (has(/后宫|群像|多人|多个角色|多角色/)) add('多人');
        if (has(/合集|多个独立场景|多个独立角色可切换/)) add('合集');
        if (has(/abo|alpha|beta|omega|信息素|腺体/)) add('ABO');
        if (has(/哨兵|向导|精神体|精神图景|结合热/)) add('向哨');
    }
    if (!tags.length) add(currentCategoryTags()[0]);
    return {
        tags: tags.slice(0, 7),
        summary: '上游分类接口连续无正文/格式异常，CardVault 已根据角色卡可见元数据与结构信号完成本地兜底分类。',
        confidence: tags.length >= 2 ? 0.62 : 0.48,
        _cardvaultLocalFallback: true,
    };
}

async function callAiClassifier(card, { maxChars = 52000, useSchema = true, compact = false, minimal = false, modelOverride = '' } = {}) {
    const cfg = classifierConfig();
    const apiUrl = normalizeClassifierApiBase(cfg.classifierApiUrl);
    const model = String(modelOverride || cfg.classifierModel || '').trim();
    if (!apiUrl) throw new Error('尚未配置 CardVault 独立分类 API 地址');
    if (!model) throw new Error('尚未选择 CardVault 独立分类模型；请先点击“拉取模型”或手动填写模型名');

    const taxonomy = classificationTaxonomy();
    const allowed = currentCategoryTags().join('、');
    const systemPrompt = '你是 SillyTavern 角色卡资料分类器。本任务只做元数据/检索标签分类，不续写剧情，不复述露骨内容，不编造未出现的关系。即使资料包含成人、暴力、禁忌或其他敏感题材，也只需进行中性的标签判断并输出 JSON。';
    const prompt = `这是 CardVault 独立后台资料分类任务。你只能分析下面单独提供的待分类资料，不得参考 SillyTavern 当前聊天、当前聊天预设、当前角色或聊天历史。

请按“${taxonomy.name}”体系，为下面这张 SillyTavern 角色卡做多标签分类。

可用标签只能来自：${allowed}

分类规则：
${classifierRules()}

角色卡资料：
${minimal ? classificationMaterialMinimal(card, maxChars) : compact ? classificationMaterialCompact(card, maxChars) : classificationMaterial(card, maxChars)}

只输出一个 JSON 对象，不要 Markdown 代码块，不要解释文字，不要在 JSON 前后附加任何内容。summary 必须是单行字符串，若内容中出现换行请改为空格。格式示例：{"tags":["标签1","标签2"],"summary":"一句话理由","confidence":0.9}`;
    const body = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 900,
    };
    if (useSchema) body.response_format = { type: 'json_object' };

    const response = await request(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers: classifierHeaders(),
        body: JSON.stringify(body),
        cache: 'no-store',
    }, 90000);
    if (!response.ok) {
        throw new Error(`独立分类 API 请求失败（HTTP ${response.status}）：${await readClassifierError(response)}`);
    }
    let payload;
    try { payload = await response.json(); } catch { throw new Error('独立分类 API 返回内容不是 JSON'); }
    const structured = extractClassifierStructuredObject(payload);
    if (structured) return validateAiClassificationResult(parseAiClassificationResult(structured));
    const raw = extractClassifierText(payload);
    if (!String(raw || '').trim()) {
        throw new Error(`独立分类 API 没有返回可读取的文本内容（${classifierPayloadDiagnostic(payload)}）`);
    }
    return validateAiClassificationResult(parseAiClassificationResult(raw));
}

function friendlyAiError(error) {
    const raw = String(error?.message || error || '未知错误').replace(/\s+/g, ' ').trim();
    if (/abort|timeout|超时/i.test(raw)) return `请求超时：${raw}`;
    if (/context|token|length|too large|过长|maximum/i.test(raw)) return `资料/上下文过长：${raw}`;
    if (/429|rate|limit|频率|quota/i.test(raw)) return `API 频率/额度限制：${raw}`;
    if (/401|403|unauthor|forbidden/i.test(raw)) return `API 鉴权或访问被拒绝：${raw}`;
    if (/failed to fetch|networkerror|cors|网络请求失败/i.test(raw)) return `独立 API 网络/CORS 连接失败：${raw}`;
    if (/safety|moderation|blocked|refus|content policy|审核|拒绝/i.test(raw)) return `上游模型/渠道拒绝处理该请求：${raw}`;
    if (/json|schema|结构化|标签/i.test(raw)) return `AI 返回格式异常：${raw}`;
    return raw.slice(0, 360);
}

async function classifyCardWithAi(card) {
    const cfg = classifierConfig();
    const models = classifierFallbackModels(cfg.classifierModel).slice(0, 3);
    const primary = models[0] || cfg.classifierModel;
    const secondary = models[1] || primary;
    const tertiary = models[2] || secondary;
    const attempts = [
        { maxChars: 52000, useSchema: true, compact: false, minimal: false, modelOverride: primary, label: `完整资料 + 结构化输出 · ${primary}` },
        { maxChars: 14000, useSchema: false, compact: true, minimal: false, modelOverride: primary, label: `精简净化资料 + 普通 JSON · ${primary}` },
        { maxChars: 6500, useSchema: false, compact: false, minimal: true, modelOverride: secondary, label: `最小资料 + 自动换模型 · ${secondary}` },
    ];
    if (tertiary && tertiary !== secondary) attempts.push({ maxChars: 5200, useSchema: false, compact: false, minimal: true, modelOverride: tertiary, label: `最小资料救援 · ${tertiary}` });
    const errors = [];
    for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        try {
            return await callAiClassifier(card, attempt);
        } catch (error) {
            const reason = friendlyAiError(error);
            errors.push(`第 ${index + 1} 次（${attempt.label}）：${reason}`);
            console.warn('[CardVault] AI classify attempt failed', card?.id, attempt, error);
            if (index + 1 < attempts.length) await new Promise(resolve => setTimeout(resolve, 550));
        }
    }

    // 0.4.29：上游连续空正文/拒绝/格式异常时不再让单张卡永久卡在“未分类”。
    // 本地兜底只使用角色卡本身可见元数据与结构信号，不调用聊天主 API。
    try {
        const fallback = validateAiClassificationResult(localHeuristicClassification(card));
        console.warn('[CardVault] AI 分类全部失败，已启用本地兜底分类', card?.id, errors, fallback);
        return fallback;
    } catch (fallbackError) {
        errors.push(`本地兜底：${friendlyAiError(fallbackError)}`);
    }
    const combined = errors.join('；');
    const finalError = new Error(combined || 'AI 分类失败');
    finalError.attemptErrors = errors;
    throw finalError;
}

function showAiFailureDetails(failures) {
    if (!Array.isArray(failures) || !failures.length) return;
    const lines = failures.slice(0, 12).map((item, index) => `${index + 1}. ${item.name || item.id}\n${item.reason}`).join('\n\n');
    const more = failures.length > 12 ? `\n\n另外还有 ${failures.length - 12} 张失败。` : '';
    globalThis.alert(`CardVault AI 分类失败详情\n\n模式：${aiGenerationModeLabel()}\n\n${lines}${more}\n\n失败卡仍保持“未分类”；可点击顶部【重试失败】只重试这些卡。`);
}

async function runAiClassification({ forceAll = false, onlyFailed = false } = {}) {
    if (currentLibraryMode !== 'cards' || aiClassificationRunning) return;
    if (!loadedCards.length) throw new Error('当前没有可分类的角色卡');

    const alreadyClassified = loadedCards.filter(card => getCardClassification(card));
    const unclassified = loadedCards.filter(card => !getCardClassification(card));
    let targets;
    if (onlyFailed) {
        targets = loadedCards.filter(card => lastAiFailureIds.has(String(card.id)) && !getCardClassification(card));
        if (!targets.length) {
            lastAiFailures = [];
            lastAiFailureIds.clear();
            paintLibraryMode();
            notify('success', '上一次失败的角色卡已经没有待重试项');
            return;
        }
    } else {
        targets = forceAll ? [...loadedCards] : unclassified;
    }

    // 普通 AI 分类永远只跑新增/未分类卡。即使全部已分类，也绝不自动转成“重跑全部”。
    if (!forceAll && !onlyFailed && targets.length === 0) {
        notify('success', `没有新增或未分类角色卡：${alreadyClassified.length}/${loadedCards.length} 已分类，本次 0 次 AI 调用`);
        return;
    }

    const question = forceAll
        ? `【手动重新分类全部】\n\n当前分类体系：${classificationTaxonomy().name}\n生成模式：${aiGenerationModeLabel()}\n将重新分类 ${targets.length} 张角色卡。\n\n每张失败时最多自动再尝试 1 次，因此极端情况下调用次数可能高于 ${targets.length} 次。确定继续吗？`
        : onlyFailed
            ? `【只重试失败卡】\n\n生成模式：${aiGenerationModeLabel()}\n本次只处理上一次失败的 ${targets.length} 张，不会碰已经成功的角色卡。\n\n确定继续吗？`
            : `【增量 AI 分类】\n\n当前分类体系：${classificationTaxonomy().name}\n生成模式：${aiGenerationModeLabel()}\n已分类 ${alreadyClassified.length} 张将全部跳过，只处理 ${targets.length} 张新增 / 未分类角色卡。\n\n正常每张 1 次；若某张失败会自动用精简资料再试 1 次。是否继续？`;
    if (!globalThis.confirm(question)) return;

    const button = document.querySelector(onlyFailed ? '#cv_ai_retry_failed' : '#cv_ai_classify');
    const original = button?.innerHTML || '<i class="fa-solid fa-wand-magic-sparkles"></i><span>AI分类</span>';
    aiClassificationRunning = true;
    let done = 0;
    let failed = 0;
    const failures = [];
    try {
        document.querySelectorAll('#cv_ai_classify,#cv_ai_retry_failed').forEach(node => { node.disabled = true; });
        for (const [index, listingCard] of targets.entries()) {
            if (!document.querySelector('.cv-overlay') || currentLibraryMode !== 'cards') break;
            if (button) button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>${index + 1}/${targets.length}</span>`;
            try {
                const detail = await apiFetch(`/api/cards/${encodeURIComponent(listingCard.id)}`, { timeoutMs: 60000 });
                const result = await classifyCardWithAi(detail);
                saveCardClassification({ ...listingCard, ...detail }, result);
                lastAiFailureIds.delete(String(listingCard.id));
                done += 1;
            } catch (error) {
                failed += 1;
                const reason = friendlyAiError(error);
                failures.push({ id: String(listingCard.id), name: listingCard.name || String(listingCard.id), reason });
                console.error('[CardVault] AI classify failed', listingCard.id, error);
            }
        }
        lastAiFailures = failures;
        lastAiFailureIds = new Set(failures.map(item => item.id));
        if (document.querySelector('.cv-overlay') && currentLibraryMode === 'cards') {
            renderLoadedCards();
            paintLibraryMode();
        }
        const prefix = forceAll ? '重新分类' : onlyFailed ? '失败卡重试' : '增量分类';
        const skipped = forceAll || onlyFailed ? 0 : alreadyClassified.length;
        notify(
            failed ? 'warning' : 'success',
            failed
                ? `${prefix}完成 ${done} 张，${failed} 张失败${skipped ? `；已跳过 ${skipped} 张旧分类` : ''}；失败原因已弹出`
                : `${prefix}完成：${done} 张${skipped ? `；已跳过 ${skipped} 张旧分类` : ''}`,
        );
        if (failed) showAiFailureDetails(failures);
    } finally {
        aiClassificationRunning = false;
        document.querySelectorAll('#cv_ai_classify,#cv_ai_retry_failed').forEach(node => { node.disabled = false; });
        if (button?.isConnected) button.innerHTML = original;
        paintLibraryMode();
    }
}

async function refreshCardListFromServer() {
    if (cardListRefreshPromise) return cardListRefreshPromise;
    cardListRefreshPromise = (async () => {
        const result = await apiFetch('/api/cards?q=', { timeoutMs: 30000 });
        const cards = Array.isArray(result?.cards) ? result.cards : [];
        writeCardListCache(cards);
        return cards;
    })();
    try {
        return await cardListRefreshPromise;
    } finally {
        cardListRefreshPromise = null;
    }
}

function cardListFingerprint(cards) {
    return (Array.isArray(cards) ? cards : []).map(card => `${card?.id || ''}:${card?.updatedAt || ''}:${card?.currentVersion || ''}`).join('|');
}

function cardListCacheKey() {
    return `cardvault_card_list_cache_v${CARD_LIST_CACHE_VERSION}_${requiredCardVaultAccount()}`;
}

function compactCardForCache(card) {
    return {
        id: card.id, name: card.name || '', creator: card.creator || '', tags: Array.isArray(card.tags) ? card.tags : [],
        spec: card.spec || '', specVersion: card.specVersion || '', format: card.format || '', ext: card.ext || '',
        mime: card.mime || '', size: Number(card.size || 0), originalName: card.originalName || '',
        updatedAt: card.updatedAt || '', currentVersion: Number(card.currentVersion || 1),
    };
}

function readCardListCache() {
    try {
        const raw = localStorage.getItem(cardListCacheKey());
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (parsed?.version !== CARD_LIST_CACHE_VERSION || !Array.isArray(parsed.cards)) return [];
        return parsed.cards;
    } catch { return []; }
}

function writeCardListCache(cards) {
    try {
        localStorage.setItem(cardListCacheKey(), JSON.stringify({
            version: CARD_LIST_CACHE_VERSION,
            savedAt: Date.now(),
            cards: (Array.isArray(cards) ? cards : []).map(compactCardForCache),
        }));
    } catch (error) {
        console.warn('[CardVault] card list cache write skipped', error);
    }
}

function cardMatchesTextQuery(card) {
    const q = String(currentLibraryQuery || '').trim().toLowerCase();
    if (!q) return true;
    const ai = getCardClassification(card);
    const haystack = [
        card?.name, card?.creator, card?.spec, card?.originalName,
        ...(Array.isArray(card?.tags) ? card.tags : []),
        ...((ai?.tags || []).map(aiTagLabel)),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
}

function bindSelectableCardArticle(article, id, activate) {
    article.addEventListener('click', activate);
    article.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
    });
    article.querySelector('.cv-select-toggle')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleCardSelection(String(id));
    });
}

function createCardArticle(card) {
    const id = String(card.id);
    const article = document.createElement('article');
    article.className = 'cv-card';
    if (selectedCardIds.has(id)) article.classList.add('selected');
    article.dataset.cardId = id;
    article.tabIndex = 0;
    article.setAttribute('aria-selected', String(selectedCardIds.has(id)));
    article.innerHTML = `
      <button class="cv-select-toggle" type="button" aria-label="选择 ${escapeHtml(card.name || '角色卡')}" title="选择"><i class="fa-regular fa-circle"></i></button>
      <div class="cv-cover-wrap"><img alt="${escapeHtml(card.name)}" loading="lazy" decoding="async" data-cv-cover-id="${escapeHtml(id)}"><span class="cv-card-format">${escapeHtml(String(card.ext || card.format || '').replace('.', '').toUpperCase())}</span>${aiTagBadgesHtml(card)}</div>
      <div class="cv-card-info"><b title="${escapeHtml(card.name)}">${escapeHtml(card.name || '未命名角色')}</b><small>${escapeHtml(card.creator || '未知作者')}</small><span>${escapeHtml(card.spec || '')}</span></div>`;
    const activate = () => {
        if (selectionMode) return toggleCardSelection(id);
        const state = captureLibraryPosition(id);
        showDetail(card.id, state);
    };
    bindSelectableCardArticle(article, id, activate);
    return article;
}

function appendCardRenderBatch(grid, cards, start, count) {
    const fragment = document.createDocumentFragment();
    const end = Math.min(cards.length, start + count);
    for (let index = start; index < end; index += 1) fragment.append(createCardArticle(cards[index]));
    grid.append(fragment);
    return end;
}

function renderLoadedCards() {
    const body = document.querySelector('#cv_library_body');
    if (!body) return;
    const generation = ++cardRenderGeneration;
    resetCoverLoader();
    visibleCards = loadedCards.filter(card => cardMatchesTextQuery(card) && cardMatchesAiFilter(card));
    const validIds = new Set(visibleCards.map(card => String(card.id)));
    for (const id of [...selectedCardIds]) if (!validIds.has(id)) selectedCardIds.delete(id);

    const filterBar = buildAiFilterBar(loadedCards);
    if (!visibleCards.length) {
        const empty = document.createElement('div');
        empty.className = 'cv-empty';
        empty.innerHTML = selectedAiFilters().length === 0
            ? '<i class="fa-regular fa-folder-open"></i><b>没有找到角色卡</b><span>可以上传 PNG 或 JSON 角色卡。</span>'
            : `<i class="fa-solid fa-filter-circle-xmark"></i><b>这些标签暂时没有匹配角色卡</b><span>当前筛选：${escapeHtml(aiFilterSummary())}</span>`;
        body.replaceChildren(filterBar, empty);
        updateBulkBar();
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'cv-grid';
    body.replaceChildren(filterBar, grid);

    const mobile = shouldUseMobileLibrary();
    if (mobile) {
        appendCardRenderBatch(grid, visibleCards, 0, visibleCards.length);
        bindLazyCoverLoading(grid, true);
        bindAiTagBadgeAutoFit(grid);
        syncCardSelectionUi();
        updateBulkBar();
        return;
    }

    let cursor = appendCardRenderBatch(grid, visibleCards, 0, Math.min(8, visibleCards.length));
    bindLazyCoverLoading(grid, true);
    bindAiTagBadgeAutoFit(grid);
    syncCardSelectionUi();
    updateBulkBar();

    const pump = () => {
        if (generation !== cardRenderGeneration || !grid.isConnected) return;
        if (cursor >= visibleCards.length) {
            scheduleAiTagBadgeLayout(grid);
            return;
        }
        cursor = appendCardRenderBatch(grid, visibleCards, cursor, 4);
        bindLazyCoverLoading(grid, false);
        scheduleAiTagBadgeLayout(grid);
        setTimeout(() => requestAnimationFrame(pump), 18);
    };
    setTimeout(() => requestAnimationFrame(pump), 28);
}

async function loadCards(query = '', options = {}) {
    const body = document.querySelector('#cv_library_body');
    if (!body) return;
    currentLibraryQuery = String(query || '');
    libraryViewState.cards.query = currentLibraryQuery;
    libraryViewState.cards.category = currentAiCategoryFilter;

    // 0.4.18：先用上一次成功列表秒开首屏，网络刷新放后台继续。
    if (!loadedCards.length) {
        const cached = readCardListCache();
        if (cached.length) {
            loadedCards = cached;
            renderLoadedCards();
            document.querySelector('.cv-window')?.classList.add('cv-using-cache');
        } else {
            body.innerHTML = '<div class="cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取卡库……</div>';
        }
    } else {
        renderLoadedCards();
    }

    // 搜索只在本地列表中完成，不再每敲一个字都打服务器。
    if (options.localOnly) return;

    try {
        const freshCards = await refreshCardListFromServer();
        const changed = cardListFingerprint(freshCards) !== cardListFingerprint(loadedCards);
        loadedCards = freshCards;
        writeCardListCache(loadedCards);
        document.querySelector('.cv-window')?.classList.remove('cv-using-cache');
        if (changed || options.force) renderLoadedCards();
    } catch (error) {
        if (!loadedCards.length) throw error;
        console.warn('[CardVault] 后台刷新卡库失败，继续使用本地缓存', error);
        notify('warning', `CardVault 后台刷新失败，已继续使用缓存：${error.message}`);
    }
}

async function loadArchiveCover(img, archiveId, signal) {
    try {
        const response = await apiFetch(`/api/play-archives/${encodeURIComponent(archiveId)}/cover`, { raw: true, signal, timeoutMs: 30000 });
        const blob = await response.blob();
        if (signal?.aborted || !img.isConnected) return;
        const url = URL.createObjectURL(blob);
        coverObjectUrls.add(url);
        img.src = url;
        img.classList.add('loaded');
    } catch {
        img.classList.add('failed');
    }
}

async function fetchAllPlayArchives(query='', signal) {
    const q=encodeURIComponent(String(query||''));
    const pageSize=200;let page=1,cursor='',all=[],seen=new Set(),pagination='none',declaredTotal=null;
    while(true){
        const cursorPart=cursor?`&cursor=${encodeURIComponent(cursor)}`:'';
        const result=await apiFetch(`/api/play-archives?q=${q}&page=${page}&pageSize=${pageSize}${cursorPart}`,{signal,timeoutMs:30000});
        const rows=Array.isArray(result?.archives)?result.archives:[];let added=0;
        for(const row of rows){const id=String(row?.id||'');if(id&&!seen.has(id)){seen.add(id);all.push(row);added++;}}
        if(Number.isFinite(Number(result?.total)))declaredTotal=Number(result.total);
        const next=String(result?.nextCursor||result?.next_cursor||'');
        const hasMore=Boolean(result?.hasMore??result?.has_more??false);
        if(next){pagination='cursor';if(next===cursor||added===0)break;cursor=next;page++;continue;}
        if(hasMore || (declaredTotal!=null&&all.length<declaredTotal)){
            pagination='page';if(added===0)break;page++;continue;
        }
        break;
    }
    return {archives:all,total:declaredTotal??all.length,pagination};
}

async function loadPlayArchives(query = '') {
    const body = document.querySelector('#cv_library_body');
    if (!body) return;
    currentLibraryQuery = String(query || '');
    libraryViewState.play.query = currentLibraryQuery;
    body.innerHTML = '<div class="cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取游玩备份……</div>';
    cleanupCoverUrls();
    const result = await fetchAllPlayArchives(currentLibraryQuery, overlayAbortController?.signal);
    const archives = Array.isArray(result?.archives) ? result.archives : [];
    visiblePlayArchives = archives;
    playArchiveServerMeta={pagination:result.pagination||'unknown',total:Number.isFinite(Number(result.total))?Number(result.total):null,loaded:archives.length};
    // U1.4：跨搜索/分页保持已选项；不再因为当前结果暂时看不见就丢选择。
    if (!archives.length) {
        body.innerHTML = '<div class="cv-empty"><i class="fa-solid fa-gamepad"></i><b>还没有游玩备份</b><span>在扩展设置中使用“归档角色、聊天与已绑定世界书并清理酒馆”。</span></div>';
        updateBulkBar();
        return;
    }
    const grid = document.createElement('div');
    grid.className = 'cv-grid cv-play-grid';
    for (const archive of archives) {
        const id = String(archive.id);
        const article = document.createElement('article');
        article.className = 'cv-card cv-play-card';
        article.dataset.archiveId = id;
        article.tabIndex = 0;
        article.setAttribute('aria-selected', String(selectedCardIds.has(id)));
        article.innerHTML = `
          <button class="cv-select-toggle" type="button" aria-label="选择 ${escapeHtml(archive.name || '游玩备份')}" title="选择"><i class="fa-regular fa-circle"></i></button>
          <div class="cv-cover-wrap"><img alt="${escapeHtml(archive.name)}" loading="lazy"><span class="cv-card-format"><i class="fa-solid fa-comments"></i> ${Number(archive.chatCount || 0)}</span></div>
          <div class="cv-card-info"><b title="${escapeHtml(archive.name)}">${escapeHtml(archive.name || '未命名角色')}</b><small>${archive.state === 'active' ? '正在酒馆中游玩' : '已归档到云端'}</small><span>世界书 ${Number(archive.worldbookCount || 0)} · 正则 ${Number(archive.regexCount || 0)} · ${formatBytes(archive.totalSize)}</span></div>`;
        const activate = () => {
            if (selectionMode) return toggleCardSelection(id);
            const state = captureLibraryPosition(id);
            showPlayArchiveDetail(archive.id, state);
        };
        bindSelectableCardArticle(article, id, activate);
        grid.append(article);
        loadArchiveCover(article.querySelector('img'), archive.id, overlayAbortController?.signal);
    }
    body.replaceChildren(grid);
    syncCardSelectionUi();
    updateBulkBar();
}

async function showPlayArchiveDetail(id, returnState = captureLibraryPosition(id)) {
    const windowEl = document.querySelector('.cv-window');
    if (!windowEl) return;
    windowEl.innerHTML = '<div class="cv-loading full"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取游玩备份……</div>';
    const archive = await apiFetch(`/api/play-archives/${encodeURIComponent(id)}`, { signal: overlayAbortController?.signal, timeoutMs: 30000 });
    const chats = Array.isArray(archive.chats) ? archive.chats : [];
    windowEl.innerHTML = `
      <header class="cv-header cv-detail-toolbar">
        <button id="cv_detail_back" class="menu_button cv-back-button" type="button"><i class="fa-solid fa-arrow-left"></i><span>返回游玩备份</span></button>
        <div class="cv-detail-toolbar-title"><b>${escapeHtml(archive.name)}</b><small>完整游玩档案 · 修订 ${Number(archive.revision || 1)}</small></div>
        <button id="cv_library_close" class="menu_button cv-close" type="button"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <main class="cv-detail-scroll cv-detail-v2">
        <section class="cv-detail-hero">
          <div class="cv-detail-cover-shell"><div class="cv-detail-cover"><img id="cv_detail_cover" alt="${escapeHtml(archive.name)}"></div><span class="cv-cover-spec">游玩备份</span></div>
          <div class="cv-detail-summary">
            <div class="cv-detail-eyebrow"><span><i class="fa-solid fa-shield-halved"></i> ${archive.complete ? '完整校验通过' : '未完成'}</span><span>${escapeHtml(archive.state || 'archived')}</span></div>
            <h2>${escapeHtml(archive.name)}</h2>
            <div class="cv-meta-grid">
              <div><small>聊天记录</small><b>${Number(archive.chatCount || 0)} 个</b></div>
              <div><small>内嵌世界书</small><b>${Number(archive.worldbookCount || 0)} 条</b></div>
              <div><small>Scoped Regex</small><b>${Number(archive.regexCount || 0)} 条</b></div>
              <div><small>备份大小</small><b>${formatBytes(archive.totalSize)}</b></div>
            </div>
            <div class="cv-actions">
              <button id="cv_restore_play" class="menu_button cv-primary" type="button"><i class="fa-solid fa-play"></i><span>下载到酒馆并开始游玩</span></button>
              <button id="cv_download_play_card" class="menu_button" type="button"><i class="fa-solid fa-download"></i><span>仅下载角色卡</span></button>
              <button id="cv_verify_play" class="menu_button" type="button"><i class="fa-solid fa-shield"></i><span>重新校验</span></button>
            </div>
            <p class="cv-detail-hint"><i class="fa-solid fa-circle-info"></i> 恢复时会导入原角色 PNG，并恢复全部 JSONL 聊天；酒馆现有角色不会被清空。可在“批量管理”中一次选择任意数量游玩备份批量恢复。卡内世界书和正则随 PNG 一起恢复。</p>
          </div>
        </section>
        <section class="cv-pane">
          <div class="cv-section-heading"><div><h3>聊天记录</h3><small>${chats.length} 个 JSONL 文件</small></div></div>
          ${chats.length ? `<div class="cv-chat-archive-list">${chats.map(chat => `<div class="cv-version-row"><div><b>${escapeHtml(chat.originalName || chat.name)}</b><small>${formatBytes(chat.size)} · SHA256 ${escapeHtml(String(chat.sha256 || '').slice(0, 12))}…</small></div></div>`).join('')}</div>` : '<div class="cv-empty compact"><b>这张角色没有历史聊天</b></div>'}
          <button id="cv_delete_play" class="menu_button cv-danger cv-play-delete" type="button"><i class="fa-solid fa-trash-can"></i> 删除这个游玩备份</button>
        </section>
      </main>`;
    windowEl.querySelector('#cv_library_close').addEventListener('click', closeOverlay);
    windowEl.querySelector('#cv_detail_back').addEventListener('click', () => {
        returnToLibrary('play', returnState).catch(error => notify('error', error.message));
    });
    windowEl.querySelector('#cv_restore_play').addEventListener('click', event => restorePlayArchiveToSillyTavern(archive, event.currentTarget));
    windowEl.querySelector('#cv_download_play_card').addEventListener('click', async () => {
        const response = await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/character`, { raw: true, timeoutMs: 90000 });
        downloadBlob(await response.blob(), safeFilename(archive.characterOriginalName || archive.originalAvatarName || `${archive.name}.png`));
    });
    windowEl.querySelector('#cv_verify_play').addEventListener('click', async event => {
        const button = event.currentTarget; const original = button.innerHTML;
        try { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 校验中'; const result = await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/verify`); notify('success', result.ok ? '游玩备份完整，所有 SHA256 校验通过' : '游玩备份校验失败'); }
        catch (error) { notify('error', error.message); }
        finally { button.disabled = false; button.innerHTML = original; }
    });
    windowEl.querySelector('#cv_delete_play').addEventListener('click', async () => {
        if (!globalThis.confirm(`确定删除“${archive.name}”的游玩备份吗？\n\n服务器会先移动到回收目录，不会立即物理清空。`)) return;
        await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}`, { method: 'DELETE' });
        notify('success', '游玩备份已移入服务器回收目录');
        await returnToLibrary('play', returnState);
    });
    loadArchiveCover(windowEl.querySelector('#cv_detail_cover'), archive.id, overlayAbortController?.signal);
}

function valueFromCard(card) {
    return card?.data?.data && typeof card.data.data === 'object' ? card.data.data : (card?.data || {});
}

function overviewHtml(card) {
    const data = valueFromCard(card);
    const fields = [
        ['角色描述', data.description], ['性格', data.personality], ['场景', data.scenario],
        ['首条消息', data.first_mes], ['示例对话', data.mes_example], ['创作者备注', data.creator_notes],
    ];
    return fields.map(([title, value]) => `<section class="cv-text-section"><h3>${title}</h3><pre>${escapeHtml(value || '（空）')}</pre></section>`).join('');
}

function worldbookHtml(card) {
    const book = card.worldbook;
    if (!book) return '<div class="cv-empty compact"><i class="fa-solid fa-book"></i><b>这张卡没有内嵌世界书</b></div>';
    const entries = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
    const header = `<div class="cv-section-heading"><div><h3>${escapeHtml(book.name || '角色世界书')}</h3><small>${entries.length} 条条目</small></div><button id="cv_download_worldbook" class="menu_button" type="button"><i class="fa-solid fa-download"></i> 导出 JSON</button></div>`;
    return header + entries.map((entry, index) => {
        const keys = Array.isArray(entry.keys) ? entry.keys : (Array.isArray(entry.key) ? entry.key : []);
        return `<details class="cv-entry"><summary><span>${escapeHtml(entry.comment || entry.name || `条目 ${index + 1}`)}</span><small>${entry.enabled === false || entry.disable === true ? '已禁用' : '已启用'}</small></summary><div class="cv-entry-meta"><b>关键词：</b>${escapeHtml(keys.join(', ') || '无')}</div><pre>${escapeHtml(entry.content || '')}</pre></details>`;
    }).join('');
}

function regexHtml(card) {
    const list = Array.isArray(card.regex) ? card.regex : [];
    if (!list.length) return '<div class="cv-empty compact"><i class="fa-solid fa-code"></i><b>这张卡没有 Scoped Regex</b></div>';
    const header = `<div class="cv-section-heading"><div><h3>Scoped Regex</h3><small>${list.length} 条规则</small></div><button id="cv_download_regex" class="menu_button" type="button"><i class="fa-solid fa-download"></i> 导出 JSON</button></div>`;
    return header + list.map((rule, index) => `<details class="cv-entry"><summary><span>${escapeHtml(rule.scriptName || rule.name || `正则 ${index + 1}`)}</span><small>${rule.disabled ? '已禁用' : '已启用'}</small></summary><h4>查找</h4><pre>${escapeHtml(rule.findRegex || '')}</pre><h4>替换</h4><pre>${escapeHtml(rule.replaceString || '')}</pre></details>`).join('');
}

function attachmentsHtml(card) {
    const list = Array.isArray(card.attachments) ? card.attachments : [];
    if (!list.length) return '<div class="cv-empty compact"><i class="fa-solid fa-paperclip"></i><b>没有附属资源</b></div>';
    return `<div class="cv-attachment-list">${list.map(item => `<div class="cv-attachment-row"><i class="fa-regular fa-file"></i><div><b>${escapeHtml(item.name)}</b><small>${formatBytes(item.size)}</small></div><button class="menu_button cv-download-attachment" data-name="${encodeURIComponent(item.name)}" type="button"><i class="fa-solid fa-download"></i> 下载</button></div>`).join('')}</div>`;
}

function versionsHtml(card) {
    const versions = Array.isArray(card.versions) ? [...card.versions].reverse() : [];
    if (!versions.length) return '<div class="cv-empty compact"><b>没有版本记录</b></div>';
    return `<div class="cv-version-list">${versions.map(version => `<div class="cv-version-row"><div><b>版本 ${escapeHtml(version.version)}</b><small>${escapeHtml(version.note || '无备注')} · ${escapeHtml(formatDate(version.createdAt))}</small></div><span>${Number(version.version) === Number(card.currentVersion) ? '当前版本' : ''}</span></div>`).join('')}</div>`;
}

function formatBytes(size) {
    const bytes = Number(size || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
    if (!value) return '未知时间';
    try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch { return String(value); }
}

async function showDetail(id, returnState = captureLibraryPosition(id)) {
    const windowEl = document.querySelector('.cv-window');
    if (!windowEl) return;
    windowEl.innerHTML = '<div class="cv-loading full"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取角色卡……</div>';
    const card = await apiFetch(`/api/cards/${encodeURIComponent(id)}`, { signal: overlayAbortController?.signal });
    const aiRecord = getCardClassification(card);
    const nativeTags = Array.isArray(card.tags) ? card.tags.filter(Boolean) : [];
    const tags = [...new Set([...(aiRecord?.tags || []), ...nativeTags])].slice(0, 10);
    windowEl.innerHTML = `
      <header class="cv-header cv-detail-toolbar">
        <button id="cv_detail_back" class="menu_button cv-back-button" type="button"><i class="fa-solid fa-arrow-left"></i><span>返回卡库</span></button>
        <div class="cv-detail-toolbar-title"><b>${escapeHtml(card.name)}</b><small>${escapeHtml(card.creator || '未知作者')}</small></div>
        <button id="cv_library_close" class="menu_button cv-close" type="button" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <main class="cv-detail-scroll cv-detail-v2">
        <section class="cv-detail-hero">
          <div class="cv-detail-cover-shell">
            <div class="cv-detail-cover"><img id="cv_detail_cover" alt="${escapeHtml(card.name)}"></div>
            <span class="cv-cover-spec">${escapeHtml(card.spec || card.format || '角色卡')}</span>
          </div>
          <div class="cv-detail-summary">
            <div class="cv-detail-eyebrow"><span><i class="fa-solid fa-user-pen"></i> ${escapeHtml(card.creator || '未知作者')}</span><span>${escapeHtml(card.spec || card.format || '')}</span></div>
            <h2>${escapeHtml(card.name)}</h2>
            ${tags.length ? `<div class="cv-detail-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            <div class="cv-meta-grid">
              <div><small>卡片规格</small><b>${escapeHtml(card.specVersion || '—')}</b></div>
              <div><small>文件大小</small><b>${formatBytes(card.size)}</b></div>
              <div><small>云端版本</small><b>${escapeHtml(card.currentVersion || 1)}</b></div>
            </div>
            <div class="cv-actions">
              <button id="cv_import_st" class="menu_button cv-primary" type="button"><i class="fa-solid fa-file-import"></i><span>自动导入酒馆</span></button>
              <button id="cv_download_card" class="menu_button" type="button"><i class="fa-solid fa-download"></i><span>下载卡片</span></button>
            </div>
            <p class="cv-detail-hint"><i class="fa-solid fa-circle-info"></i> 自动静默导入角色卡、世界书与 Scoped Regex；导入后会校验，缺失时自动补回。</p>
          </div>
        </section>
        <nav class="cv-tabs" aria-label="角色卡详情选项卡">
          <button class="menu_button active" data-cv-tab="overview" type="button"><i class="fa-regular fa-address-card"></i> 概览</button>
          <button class="menu_button" data-cv-tab="worldbook" type="button"><i class="fa-solid fa-book"></i> 世界书</button>
          <button class="menu_button" data-cv-tab="regex" type="button"><i class="fa-solid fa-code"></i> 正则</button>
          <button class="menu_button" data-cv-tab="attachments" type="button"><i class="fa-solid fa-paperclip"></i> 附属资源</button>
          <button class="menu_button" data-cv-tab="versions" type="button"><i class="fa-solid fa-clock-rotate-left"></i> 版本</button>
        </nav>
        <section id="cv_detail_pane" class="cv-pane"></section>
      </main>`;

    windowEl.querySelector('#cv_library_close').addEventListener('click', closeOverlay);
    windowEl.querySelector('#cv_detail_back').addEventListener('click', () => {
        returnToLibrary('cards', returnState).catch(error => notify('error', error.message));
    });
    windowEl.querySelector('#cv_import_st').addEventListener('click', event => importToSillyTavern(card, event.currentTarget));
    windowEl.querySelector('#cv_download_card').addEventListener('click', () => downloadCard(card));
    for (const button of windowEl.querySelectorAll('[data-cv-tab]')) {
        button.addEventListener('click', () => {
            windowEl.querySelectorAll('[data-cv-tab]').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            renderPane(card, button.dataset.cvTab);
            windowEl.querySelector('.cv-detail-scroll')?.scrollTo({ top: Math.max(0, windowEl.querySelector('.cv-tabs')?.offsetTop - 12), behavior: 'smooth' });
        });
    }
    loadCover(windowEl.querySelector('#cv_detail_cover'), card.id, overlayAbortController?.signal);
    renderPane(card, 'overview');
}

function renderPane(card, tab) {
    const pane = document.querySelector('#cv_detail_pane');
    if (!pane) return;
    const htmlByTab = {
        overview: () => overviewHtml(card), worldbook: () => worldbookHtml(card), regex: () => regexHtml(card),
        attachments: () => attachmentsHtml(card), versions: () => versionsHtml(card),
    };
    pane.innerHTML = (htmlByTab[tab] || htmlByTab.overview)();

    pane.querySelector('#cv_download_worldbook')?.addEventListener('click', () => downloadJson(card.worldbook, `${safeFilename(card.name)}__世界书.json`));
    pane.querySelector('#cv_download_regex')?.addEventListener('click', () => downloadJson(card.regex, `${safeFilename(card.name)}__正则.json`));
    pane.querySelectorAll('.cv-download-attachment').forEach(button => {
        button.addEventListener('click', () => downloadAttachment(card.id, decodeURIComponent(button.dataset.name)));
    });
}

async function downloadCard(card) {
    const response = await apiFetch(`/api/cards/${encodeURIComponent(card.id)}/file`, { raw: true, timeoutMs: 60000 });
    const blob = await response.blob();
    const ext = String(card.ext || '.png').startsWith('.') ? card.ext : `.${card.ext}`;
    downloadBlob(blob, `${safeFilename(card.name)}${ext}`);
}

async function downloadAttachment(cardId, name) {
    const response = await apiFetch(`/api/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(name)}`, { raw: true, timeoutMs: 60000 });
    downloadBlob(await response.blob(), safeFilename(name, 'attachment.bin'));
}

function downloadJson(value, filename) {
    downloadBlob(new Blob([JSON.stringify(value ?? null, null, 2)], { type: 'application/json;charset=utf-8' }), filename);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function requestHeaders() {
    const ctx = context();
    const headers = ctx.getRequestHeaders?.() || globalThis.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    return { ...headers };
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function normalizeAvatarName(value) {
    return String(value || '').trim().replace(/^.*[\\/]/, '');
}

function characterList() {
    const ctx = context();
    return Array.isArray(ctx.characters) ? ctx.characters : (Array.isArray(globalThis.characters) ? globalThis.characters : []);
}

async function refreshCharacterList() {
    const ctx = context();
    if (typeof ctx.getCharacters === 'function') {
        try { await ctx.getCharacters(); } catch (error) { console.warn('[CardVault] 刷新角色列表失败', error); }
    }
    return characterList();
}

async function findImportedCharacter(importResult, card) {
    const exactCandidates = [importResult?.file_name, importResult?.avatar, importResult?.avatar_url]
        .map(normalizeAvatarName).filter(Boolean);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const list = await refreshCharacterList();
        let index = -1;
        if (exactCandidates.length) {
            index = list.findIndex(item => exactCandidates.includes(normalizeAvatarName(item?.avatar)));
        }
        if (index < 0) {
            const targetName = String(card?.name || '').trim();
            for (let i = list.length - 1; i >= 0; i -= 1) {
                if (String(list[i]?.name || '').trim() === targetName) { index = i; break; }
            }
        }
        if (index >= 0) return { index, character: list[index] };
        await new Promise(resolve => setTimeout(resolve, 180 + attempt * 70));
    }
    throw new Error('角色卡已经上传，但暂时找不到酒馆中的新角色，无法执行世界书/正则自动校验');
}

async function loadImportGuardianModules() {
    if (!importGuardianModulePromise) {
        importGuardianModulePromise = Promise.all([
            import('/scripts/world-info.js'),
            import('/scripts/extensions.js'),
            import('/scripts/extensions/regex/engine.js'),
        ]).then(([worldInfo, extensions, regexEngine]) => ({ worldInfo, extensions, regexEngine }))
            .catch(error => {
                importGuardianModulePromise = null;
                throw error;
            });
    }
    return importGuardianModulePromise;
}

function chooseEmbeddedWorldbook(fullCharacter, card) {
    // CardVault 详情里的解析结果是本次导入的源数据，优先级高于酒馆导入后可能被裁剪/漏写的字段。
    const fromVault = card?.worldbook;
    if (fromVault && typeof fromVault === 'object' && fromVault.entries) return fromVault;
    const embedded = fullCharacter?.data?.character_book;
    if (embedded && typeof embedded === 'object' && Array.isArray(embedded.entries)) return embedded;
    return null;
}

function chooseScopedRegex(fullCharacter, card) {
    // 同理优先使用 CardVault 完整解析出的 Scoped Regex，避免酒馆原生导入只留下部分规则时误判为完整。
    const fromVault = card?.regex;
    if (Array.isArray(fromVault) && fromVault.length) return fromVault;
    const embedded = fullCharacter?.data?.extensions?.regex_scripts;
    return Array.isArray(embedded) ? embedded : [];
}

function worldbookNameForImport(source, fullCharacter, card) {
    return String(
        source?.name ||
        fullCharacter?.data?.character_book?.name ||
        fullCharacter?.data?.extensions?.world ||
        `${fullCharacter?.name || card?.name || '角色'}'s Lorebook`
    ).trim();
}

function worldbookPayloadForImport(source, modules) {
    if (!source || typeof source !== 'object') return null;
    if (Array.isArray(source.entries)) {
        return modules.worldInfo.convertCharacterBook(cloneJson(source));
    }
    if (source.entries && typeof source.entries === 'object') {
        return cloneJson(source);
    }
    return null;
}

function regexFingerprint(list) {
    const scripts = Array.isArray(list) ? list : [];
    const simplified = scripts.map(rule => ({
        id: rule?.id ?? null,
        name: rule?.scriptName ?? rule?.name ?? '',
        find: rule?.findRegex ?? '',
        replace: rule?.replaceString ?? '',
        disabled: Boolean(rule?.disabled),
        placement: rule?.placement ?? rule?.placementFlags ?? null,
    }));
    let hash = 2166136261;
    const raw = JSON.stringify(simplified);
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function rememberImportGuardian(character, card, worldName, regexList) {
    const avatar = normalizeAvatarName(character?.avatar);
    if (!avatar || !card?.id) return;
    const cfg = extensionSettings();
    cfg.importGuardianMap[avatar] = {
        cardId: String(card.id),
        cardName: String(card.name || character?.name || ''),
        worldName: String(worldName || ''),
        regexCount: Array.isArray(regexList) ? regexList.length : 0,
        regexFingerprint: regexFingerprint(regexList),
        updatedAt: Date.now(),
    };
    saveSettings();
}

async function ensureImportedArtifacts({ card, characterIndex, quiet = false, reason = 'import' }) {
    const list = characterList();
    const character = list?.[characterIndex];
    if (!character?.avatar) throw new Error('找不到要校验的酒馆角色');

    const modules = await loadImportGuardianModules();
    let fullCharacter = await getFullCharacterFromSillyTavern(character);
    const sourceWorld = chooseEmbeddedWorldbook(fullCharacter, card);
    const desiredRegex = chooseScopedRegex(fullCharacter, card);
    let worldName = '';
    let worldRepaired = false;
    let regexRepaired = false;

    if (sourceWorld) {
        worldName = worldbookNameForImport(sourceWorld, fullCharacter, card);
        const worldPayload = worldbookPayloadForImport(sourceWorld, modules);
        if (worldName && worldPayload) {
            // CardVault 明确执行导入时，以卡内世界书为准静默落盘；无需 SillyTavern 的二次确认弹窗。
            await modules.worldInfo.saveWorldInfo(worldName, worldPayload, true);
            if (typeof modules.worldInfo.updateWorldInfoList === 'function') await modules.worldInfo.updateWorldInfoList();
            await modules.extensions.writeExtensionField(characterIndex, 'world', worldName);
            worldRepaired = true;
        }
    } else {
        worldName = linkedWorldbookNameFromCharacterJson(fullCharacter);
    }

    if (desiredRegex.length) {
        await modules.extensions.writeExtensionField(characterIndex, 'regex_scripts', cloneJson(desiredRegex));
        await refreshCharacterList();
        const refreshedCharacter = characterList()?.[characterIndex];
        if (refreshedCharacter && typeof modules.regexEngine.allowScopedScripts === 'function') {
            modules.regexEngine.allowScopedScripts(refreshedCharacter);
        }
        regexRepaired = true;
    }

    await refreshCharacterList();
    const finalCharacter = characterList()?.[characterIndex] || character;
    fullCharacter = await getFullCharacterFromSillyTavern(finalCharacter);

    if (worldName) {
        const linkedName = linkedWorldbookNameFromCharacterJson(fullCharacter);
        if (linkedName !== worldName) {
            await modules.extensions.writeExtensionField(characterIndex, 'world', worldName);
            fullCharacter = await getFullCharacterFromSillyTavern(finalCharacter);
        }
        const worldCheck = await readLinkedWorldbookFromSillyTavern(fullCharacter);
        if (!worldCheck) throw new Error(`角色已导入，但世界书“${worldName}”自动补写后仍无法读取`);
    }

    const finalRegex = Array.isArray(fullCharacter?.data?.extensions?.regex_scripts)
        ? fullCharacter.data.extensions.regex_scripts
        : [];
    if (desiredRegex.length && regexFingerprint(finalRegex) !== regexFingerprint(desiredRegex)) {
        throw new Error(`角色已导入，但 Scoped Regex 自动补写后校验不一致（应有 ${desiredRegex.length} 条）`);
    }

    rememberImportGuardian(finalCharacter, card, worldName, desiredRegex);
    if (!quiet) {
        const worldText = worldName ? `世界书“${worldName}”` : '无世界书';
        const regexText = desiredRegex.length ? `${desiredRegex.length} 条 Scoped Regex` : '无 Scoped Regex';
        notify('success', `${card.name} 已静默导入并校验完成：${worldText} · ${regexText}`);
    } else if (reason === 'heal' && (worldRepaired || regexRepaired)) {
        notify('success', `CardVault 已自动补回“${card.name || finalCharacter?.name || '角色'}”缺失的世界书/Scoped Regex`);
    }

    return { character: finalCharacter, worldName, regexCount: desiredRegex.length };
}

async function getCardDetailForGuardian(cardId) {
    return apiFetch(`/api/cards/${encodeURIComponent(cardId)}`, { timeoutMs: 60000 });
}

async function guardianWorldbookReadable(fullCharacter, expectedName) {
    if (!expectedName) return true;
    if (linkedWorldbookNameFromCharacterJson(fullCharacter) !== expectedName) return false;
    try { return Boolean(await readLinkedWorldbookFromSillyTavern(fullCharacter)); } catch { return false; }
}

async function runImportGuardianSweep({ force = false } = {}) {
    if (importGuardianRunning || cardVaultAccessDisabled) return;
    const now = Date.now();
    if (!force && now - lastImportGuardianSweep < 3500) return;
    lastImportGuardianSweep = now;
    importGuardianRunning = true;
    try {
        const ctx = context();
        const characterIndex = Number(ctx.characterId);
        if (!Number.isInteger(characterIndex) || characterIndex < 0) return;
        const character = characterList()?.[characterIndex];
        const avatar = normalizeAvatarName(character?.avatar);
        if (!avatar) return;
        const record = extensionSettings().importGuardianMap?.[avatar];
        if (!record?.cardId) return;

        const fullCharacter = await getFullCharacterFromSillyTavern(character);
        const currentRegex = Array.isArray(fullCharacter?.data?.extensions?.regex_scripts)
            ? fullCharacter.data.extensions.regex_scripts
            : [];
        const worldOk = await guardianWorldbookReadable(fullCharacter, String(record.worldName || ''));
        let regexOk = currentRegex.length === Number(record.regexCount || 0);
        if (regexOk && Number(record.regexCount || 0) > 0 && record.regexFingerprint) {
            regexOk = regexFingerprint(currentRegex) === record.regexFingerprint;
        }
        if (regexOk && currentRegex.length) {
            try {
                const modules = await loadImportGuardianModules();
                if (typeof modules.regexEngine.isScopedScriptsAllowed === 'function') {
                    regexOk = Boolean(modules.regexEngine.isScopedScriptsAllowed(character));
                }
            } catch (error) {
                console.warn('[CardVault] Scoped Regex 允许状态检查失败，将只校验卡内规则', error);
            }
        }
        if (worldOk && regexOk) return;

        const card = await getCardDetailForGuardian(record.cardId);
        await ensureImportedArtifacts({ card, characterIndex, quiet: true, reason: 'heal' });
    } catch (error) {
        console.warn('[CardVault] 自动导入守护检查失败', error);
    } finally {
        importGuardianRunning = false;
    }
}

function installImportGuardian() {
    if (importGuardianCleanups.length) return;
    const trigger=()=>void runImportGuardianSweep({force:true});
    const onVisibility=()=>{if(document.visibilityState==='visible')trigger();};
    window.addEventListener('focus',trigger,{passive:true});
    document.addEventListener('visibilitychange',onVisibility,{passive:true});
    importGuardianCleanups.push(()=>window.removeEventListener('focus',trigger),()=>document.removeEventListener('visibilitychange',onVisibility));

    // 酒馆自身已经有可靠事件，不再用30秒轮询。切角色/切聊天/应用就绪时才检查。
    const bus=globalThis.VVVUnifiedCore?.events;
    if(bus?.on){
        for(const eventName of ['CHAT_CHANGED','CHARACTER_EDITED','APP_READY']){
            const off=bus.on(eventName,trigger);
            if(typeof off==='function')importGuardianCleanups.push(off);
        }
    }
    globalThis.cardVaultImportGuardian={
        version:'0.4.31-u171',
        check:()=>runImportGuardianSweep({force:true}),
        records:()=>cloneJson(extensionSettings().importGuardianMap),
    };
}

async function importToSillyTavern(card, button) {
    const originalText = button?.innerHTML;
    try {
        if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在静默导入……'; }
        const response = await apiFetch(`/api/cards/${encodeURIComponent(card.id)}/file`, { raw: true, timeoutMs: 90000 });
        const blob = await response.blob();
        const ext = String(card.ext || '.png').replace(/^\./, '').toLowerCase();
        const filename = `${safeFilename(card.name)}.${ext}`;
        const form = new FormData();
        form.append('avatar', new File([blob], filename, { type: card.mime || blob.type || 'application/octet-stream' }));
        form.append('file_type', ext);
        form.append('preserved_name', safeFilename(card.name));

        const headers = requestHeaders();
        delete headers['Content-Type'];
        delete headers['content-type'];
        const importResponse = await request('/api/characters/import', { method: 'POST', headers, body: form }, 120000);
        const result = await parseResponse(importResponse);
        if (!importResponse.ok || result?.error) throw new Error(result?.message || result?.error || `酒馆导入失败（HTTP ${importResponse.status}）`);

        if (button) button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在补齐世界书/正则……';
        const imported = await findImportedCharacter(result, card);
        await ensureImportedArtifacts({ card, characterIndex: imported.index, quiet: false, reason: 'import' });
        installImportGuardian();
    } catch (error) {
        console.error('[CardVault] Silent import failed', error);
        notify('error', error.message || '自动导入失败');
    } finally {
        if (button) { button.disabled = false; button.innerHTML = originalText; }
    }
}

async function exportCharacterFromSillyTavern(character) {
    if (!character?.avatar) throw new Error('角色缺少头像文件，无法导出');

    // 优先读取酒馆当前用户目录里的原始 PNG。这个入口不会重新编码，也不会清除
    // chat/fav 等私有字段，因此最适合做“游玩备份”的可逆快照。
    try {
        const rawResponse = await request(`/characters/${encodeURIComponent(character.avatar)}`, {
            method: 'GET', headers: requestHeaders(), cache: 'no-store',
        }, 120000);
        if (rawResponse.ok) {
            const blob = await rawResponse.blob();
            if (blob.size > 8) return blob;
        }
    } catch (error) {
        console.warn('[CardVault] 读取原始角色 PNG 失败，回退到酒馆导出接口', error);
    }

    const response = await request('/api/characters/export', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ format: 'png', avatar_url: character.avatar }),
    }, 120000);
    if (!response.ok) {
        const error = await parseResponse(response).catch(() => null);
        throw new Error(error?.message || `从酒馆导出角色失败（HTTP ${response.status}）`);
    }
    return response.blob();
}

async function backupCharacterToCardVault(character) {
    const blob = await exportCharacterFromSillyTavern(character);
    return uploadBlobToCardVault(
        blob,
        `${safeFilename(character.name || character.avatar)}.png`,
        'image/png',
    );
}

async function backupCurrentCharacter() {
    if (!await verify({ quiet: true })) throw new Error('请先登录 CardVault');
    const ctx = context();
    const character = ctx.characters?.[ctx.characterId];
    if (!character?.avatar) throw new Error('当前没有选中的角色');

    const result = await backupCharacterToCardVault(character);
    notify('success', result?.duplicate ? '云端已有完全相同的卡片' : '当前角色已备份到 CardVault');
}

async function backupAllCharacters(onProgress = () => {}) {
    if (!await verify({ quiet: true })) throw new Error('请先登录 CardVault');
    const ctx = context();

    if (typeof ctx.getCharacters === 'function') {
        try { await ctx.getCharacters(); } catch (error) { console.warn('[CardVault] 刷新酒馆角色列表失败，将使用当前列表', error); }
    }

    const seenAvatars = new Set();
    const characters = (Array.isArray(ctx.characters) ? ctx.characters : [])
        .filter(character => {
            const avatar = String(character?.avatar || '').trim();
            if (!avatar || seenAvatars.has(avatar)) return false;
            seenAvatars.add(avatar);
            return true;
        });

    if (!characters.length) throw new Error('当前酒馆账号中没有可以备份的角色卡');

    let added = 0;
    let duplicate = 0;
    const failed = [];

    for (let index = 0; index < characters.length; index += 1) {
        const character = characters[index];
        const name = String(character?.name || character?.avatar || `角色 ${index + 1}`);
        onProgress({ current: index + 1, total: characters.length, name });
        setStatus(`正在备份 ${index + 1}/${characters.length}：${name}`, 'loading');

        try {
            const result = await backupCharacterToCardVault(character);
            if (result?.duplicate) duplicate += 1;
            else added += 1;
        } catch (error) {
            failed.push({ name, message: error?.message || '未知错误' });
            console.error(`[CardVault] 备份角色失败：${name}`, error);
        }
    }

    const summary = `全部角色备份完成：新增 ${added} 张，重复 ${duplicate} 张，失败 ${failed.length} 张`;
    const state = failed.length === characters.length ? 'error' : (failed.length ? 'idle' : 'success');
    setStatus(summary, state);

    if (failed.length === characters.length) {
        throw new Error(`${summary}。首个错误：${failed[0]?.name}：${failed[0]?.message}`);
    }

    if (failed.length) {
        const examples = failed.slice(0, 3).map(item => item.name).join('、');
        notify('warning', `${summary}。失败角色：${examples}${failed.length > 3 ? '等' : ''}`);
    } else {
        notify('success', summary);
    }

    return { total: characters.length, added, duplicate, failed };
}

async function saveCurrentChatBeforeArchive() {
    const ctx = context();
    if (ctx.groupId) return;
    if (ctx.characterId !== undefined && typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
    }
}

async function getFullCharacterFromSillyTavern(character) {
    const response = await request('/api/characters/get', {
        method: 'POST', headers: requestHeaders(), body: JSON.stringify({ avatar_url: character.avatar }),
    }, 120000);
    const result = await parseResponse(response);
    if (!response.ok || result?.error) throw new Error(result?.message || '无法读取角色完整数据');
    return result;
}

async function readLinkedWorldbookFromSillyTavern(characterJson) {
    const name = linkedWorldbookNameFromCharacterJson(characterJson);
    if (!name) return null;
    const response = await request('/api/worldinfo/get', {
        method: 'POST', headers: requestHeaders(), body: JSON.stringify({ name }),
    }, 120000);
    const data = await parseResponse(response);
    if (!response.ok || !data || typeof data !== 'object' || !('entries' in data)) {
        console.warn(`[CardVault] 关联世界书“${name}”无法读取，将只保留角色卡内已有数据`);
        return null;
    }
    return { name, data };
}


function linkedWorldbookNameFromCharacterJson(characterJson) {
    return String(characterJson?.data?.extensions?.world || characterJson?.world || '').trim();
}

async function listSillyTavernWorldbooks() {
    const response = await request('/api/worldinfo/list', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({}),
    }, 120000);
    const result = await parseResponse(response);
    if (!response.ok || !Array.isArray(result)) {
        throw new Error(`无法读取世界书列表（HTTP ${response.status}）`);
    }
    return result.map(item => ({
        fileId: String(item?.file_id || '').trim(),
        name: String(item?.name || '').trim(),
    })).filter(item => item.fileId || item.name);
}

async function deleteLinkedWorldbooksFromSillyTavern(names, onProgress = () => {}) {
    const requestedNames = [...new Set((Array.isArray(names) ? names : [])
        .map(name => String(name || '').trim())
        .filter(Boolean))];
    if (!requestedNames.length) return { deleted: [], missing: [], failed: [] };

    const available = await listSillyTavernWorldbooks();
    const byFileId = new Map(available.map(item => [item.fileId, item]));
    const byDisplayName = new Map(available.map(item => [item.name, item]));
    const deleted = [];
    const missing = [];
    const failed = [];

    for (let index = 0; index < requestedNames.length; index += 1) {
        const requested = requestedNames[index];
        const match = byFileId.get(requested) || byDisplayName.get(requested);
        onProgress({ stage: 'worldbook-delete', name: requested, current: index + 1, total: requestedNames.length });
        if (!match) {
            missing.push(requested);
            continue;
        }
        const deleteName = match.fileId || requested;
        try {
            const response = await request('/api/worldinfo/delete', {
                method: 'POST',
                headers: requestHeaders(),
                body: JSON.stringify({ name: deleteName }),
            }, 120000);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            deleted.push(requested);
        } catch (error) {
            failed.push({ name: requested, message: error?.message || '未知错误' });
        }
    }

    return { deleted, missing, failed };
}

async function otherLocalCharactersUsingWorldbook(worldbookName, excludedAvatar) {
    const wanted = String(worldbookName || '').trim();
    if (!wanted) return [];
    const characters = await getUniqueSillyTavernCharacters();
    const matches = [];
    for (const character of characters) {
        if (String(character?.avatar || '') === String(excludedAvatar || '')) continue;
        let linkedName = linkedWorldbookNameFromCharacterJson(character);
        if (!linkedName) {
            try {
                const full = await getFullCharacterFromSillyTavern(character);
                linkedName = linkedWorldbookNameFromCharacterJson(full);
            } catch (error) {
                console.warn('[CardVault] 检查共享世界书引用失败，将保守地保留世界书', character, error);
                return [{ avatar: character?.avatar || '', name: character?.name || '未知角色', uncertain: true }];
            }
        }
        if (linkedName === wanted) matches.push(character);
    }
    return matches;
}

async function restoreLinkedWorldbookToSillyTavern(archive) {
    if (!archive?.linkedWorldbook?.name) return { restored: false, reason: 'none' };
    const response = await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/worldbook`, { raw: true, timeoutMs: 120000 });
    const data = await response.json();
    const name = String(archive.linkedWorldbook.name);

    let current = null;
    try {
        const currentResponse = await request('/api/worldinfo/get', {
            method: 'POST', headers: requestHeaders(), body: JSON.stringify({ name }),
        }, 60000);
        if (currentResponse.ok) current = await parseResponse(currentResponse);
    } catch {}

    const currentHasEntries = current && typeof current === 'object' && Object.keys(current.entries || {}).length > 0;
    const same = currentHasEntries && JSON.stringify(current) === JSON.stringify(data);
    if (same) return { restored: false, reason: 'same' };
    if (currentHasEntries && !await cardVaultConfirm({
        title: '发现同名世界书',
        message: `酒馆里已经存在同名世界书“${name}”，但内容与游玩备份不同。\n\n是否用备份版本覆盖？\n取消后角色仍会恢复，但会继续使用酒馆现有的同名世界书。`,
        confirmText: '覆盖世界书',
        cancelText: '保留现有版本',
        danger: true,
    })) {
        return { restored: false, reason: 'kept-existing' };
    }

    const editResponse = await request('/api/worldinfo/edit', {
        method: 'POST', headers: requestHeaders(), body: JSON.stringify({ name, data }),
    }, 120000);
    if (!editResponse.ok) throw new Error(`恢复关联世界书失败：${name}`);
    return { restored: true, reason: 'written' };
}

async function listCharacterChatFiles(character) {
    const response = await request('/api/characters/chats', {
        method: 'POST', headers: requestHeaders(), body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
    }, 120000);
    const result = await parseResponse(response);
    if (!response.ok) throw new Error(`无法读取聊天列表（HTTP ${response.status}）`);
    if (result?.error === true) return [];
    return (Array.isArray(result) ? result : Object.values(result || {})).map(item => String(item?.file_name || '')).filter(Boolean);
}

async function exportRawChat(character, fileName) {
    const response = await request('/api/chats/export', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ is_group: false, avatar_url: character.avatar, file: fileName, exportfilename: fileName, format: 'jsonl' }),
    }, 120000);
    const result = await parseResponse(response);
    if (!response.ok || typeof result?.result !== 'string') throw new Error(result?.message || `导出聊天失败：${fileName}`);
    return new Blob([result.result], { type: 'application/x-ndjson;charset=utf-8' });
}

function playArchiveMappingForAvatar(avatar) {
    return extensionSettings().playArchiveMap?.[String(avatar || '')] || null;
}

function rememberPlayArchive(avatar, archive) {
    if (!avatar || !archive?.id) return;
    const cfg = extensionSettings();
    cfg.playArchiveMap ||= {};
    cfg.playArchiveMap[String(avatar)] = { archiveId: archive.id, archiveKey: archive.archiveKey || `st:${archive.sourceAvatar || avatar}` };
    saveSettings();
}

function forgetPlayArchiveAvatar(avatar) {
    const cfg = extensionSettings();
    if (cfg.playArchiveMap && Object.prototype.hasOwnProperty.call(cfg.playArchiveMap, avatar)) {
        delete cfg.playArchiveMap[avatar];
        saveSettings();
    }
}


const VVV_THEATER_CARD_BUNDLE_KEY = 'vvv_theater_cardvault_bundle_v1';

function bytesToBase64Utf8(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
}

function base64Utf8ToText(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function pngCrc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngU32(value) {
    return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function concatBytes(parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

function parsePngChunks(bytes) {
    const sig = [137,80,78,71,13,10,26,10];
    if (bytes.length < 8 || !sig.every((value, index) => bytes[index] === value)) throw new Error('不是有效 PNG');
    const chunks = [];
    let offset = 8;
    const decoder = new TextDecoder('latin1');
    while (offset + 12 <= bytes.length) {
        const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
        if (offset + 12 + length > bytes.length) break;
        const typeBytes = bytes.slice(offset + 4, offset + 8);
        const type = decoder.decode(typeBytes);
        const data = bytes.slice(offset + 8, offset + 8 + length);
        chunks.push({ type, typeBytes, data });
        offset += 12 + length;
        if (type === 'IEND') break;
    }
    return chunks;
}

function makePngChunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    const crc = pngCrc32(concatBytes([typeBytes, data]));
    return concatBytes([pngU32(data.length), typeBytes, data, pngU32(crc)]);
}

function extractCharacterJsonFromPngBytes(bytes) {
    const chunks = parsePngChunks(bytes);
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const zero = chunk.data.indexOf(0);
        if (zero < 0) continue;
        const keyword = new TextDecoder('latin1').decode(chunk.data.slice(0, zero));
        if (keyword !== 'chara') continue;
        const b64 = new TextDecoder('latin1').decode(chunk.data.slice(zero + 1));
        try { return JSON.parse(base64Utf8ToText(b64)); } catch { return null; }
    }
    return null;
}

function vvvTheaterBundleFromCharacterJson(characterJson) {
    return characterJson?.data?.extensions?.[VVV_THEATER_CARD_BUNDLE_KEY]
        || characterJson?.extensions?.[VVV_THEATER_CARD_BUNDLE_KEY]
        || null;
}

async function embedVvvTheaterBundleInPng(blob, bundle) {
    if (!bundle || !(blob instanceof Blob)) return blob;
    try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const chunks = parsePngChunks(bytes);
        const signature = bytes.slice(0, 8);
        let replaced = false;
        const output = [signature];
        for (const chunk of chunks) {
            if (chunk.type === 'tEXt') {
                const zero = chunk.data.indexOf(0);
                const keyword = zero >= 0 ? new TextDecoder('latin1').decode(chunk.data.slice(0, zero)) : '';
                if (keyword === 'chara') {
                    const b64 = new TextDecoder('latin1').decode(chunk.data.slice(zero + 1));
                    const json = JSON.parse(base64Utf8ToText(b64));
                    json.data ||= {};
                    json.data.extensions ||= {};
                    json.data.extensions[VVV_THEATER_CARD_BUNDLE_KEY] = bundle;
                    const encoded = new TextEncoder().encode(`chara\0${bytesToBase64Utf8(JSON.stringify(json))}`);
                    output.push(makePngChunk('tEXt', encoded));
                    replaced = true;
                    continue;
                }
            }
            output.push(makePngChunk(chunk.type, chunk.data));
        }
        if (!replaced) return blob;
        return new Blob(output, { type: 'image/png' });
    } catch (error) {
        console.warn('[CardVault] 0-32伴随档案写入角色PNG失败，继续使用原PNG', error);
        return blob;
    }
}

async function currentVvvTheaterBundleForCharacter(character) {
    const bridge = globalThis.VVVTheaterCardVaultBridge;
    const memoryBridge = globalThis.VVVTheaterMemoryBridge;
    const identity = memoryBridge?.getArchiveIdentity?.() || {};
    const currentAvatar = String(identity?.avatar || '').trim();
    const targetAvatar = String(character?.avatar || '').trim();
    const targetName = String(character?.name || '').trim();

    // 当前正在玩的角色先走前端桥：会先flush最新状态，拿到的是最实时的一份。
    if (bridge?.exportForCurrentCharacter && (!currentAvatar || !targetAvatar || currentAvatar === targetAvatar)) {
        try {
            const bundle = await bridge.exportForCurrentCharacter();
            if (bundle && typeof bundle === 'object') return bundle;
        } catch (error) {
            console.warn('[CardVault] 当前角色0-32伴随档案前端导出失败，尝试服务器永久库', error);
        }
    }

    // U1.2：归档多个本地角色时，非当前角色不能再直接return null。
    // 从0-32服务器永久库按 avatar / characterName 找回该角色的全部“角色 + 每聊天”档案。
    if (targetAvatar || targetName) {
        try {
            const response = await request('/api/plugins/vvv-theater-memory-server/archives/character/export-by-identity', {
                method: 'POST',
                headers: requestHeaders(),
                body: JSON.stringify({ avatar: targetAvatar, characterName: targetName }),
            }, 120000);
            const data = await parseResponse(response);
            if (response.ok && data?.bundle && typeof data.bundle === 'object') return data.bundle;
            if (response.status === 404) return null; // 该角色从未产生0-32永久档案，属于正常情况。
            throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
        } catch (error) {
            console.warn('[CardVault] 未检测到可用的0-32服务器永久库；独立版继续归档角色卡/聊天/世界书，不携带该角色的0-32伴随档案', error);
            return null;
        }
    }
    return null;
}

async function restoreVvvTheaterBundleForCurrentCharacter(bundle, options = {}) {
    if (!bundle) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const bridge = globalThis.VVVTheaterCardVaultBridge;
        if (bridge?.importForCurrentCharacter) {
            try {
                await bridge.importForCurrentCharacter(bundle);
                if (!options.silent) notify('success', '0-32 永久伴随档案已随角色卡恢复');
                return true;
            } catch (error) {
                console.warn('[CardVault] 恢复0-32伴随档案失败，稍后重试', error);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 450 + attempt * 250));
    }
    if (!options.silent) notify('warning', '角色与聊天已恢复，但0-32伴随档案桥暂未就绪；打开0-32后可再次导入');
    return false;
}

async function backupCharacterAsPlayArchive(character, onProgress = () => {}) {
    if (!character?.avatar) throw new Error('角色缺少头像文件名');
    const mapping = playArchiveMappingForAvatar(character.avatar);
    let [cardBlob, characterJson, chatFiles] = await Promise.all([
        exportCharacterFromSillyTavern(character),
        getFullCharacterFromSillyTavern(character),
        listCharacterChatFiles(character),
    ]);
    const theaterBundle = await currentVvvTheaterBundleForCharacter(character);
    if (theaterBundle) {
        characterJson = cloneJson(characterJson);
        characterJson.data ||= {};
        characterJson.data.extensions ||= {};
        characterJson.data.extensions[VVV_THEATER_CARD_BUNDLE_KEY] = theaterBundle;
        cardBlob = await embedVvvTheaterBundleInPng(cardBlob, theaterBundle);
    }
    const linkedWorldbook = await readLinkedWorldbookFromSillyTavern(characterJson);
    const archiveKey = mapping?.archiveKey || `st:${character.avatar}`;
    const session = await apiFetch('/api/play-archives/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: character.name || character.avatar, sourceAvatar: character.avatar, originalAvatarName: character.avatar, archiveKey, source: 'sillytavern', chatCount: chatFiles.length }),
        timeoutMs: 30000,
    });
    let committed = false;
    try {
        onProgress({ stage: 'character', name: character.name, current: 0, total: chatFiles.length });
        // 0.4.1：不再依赖浏览器端 crypto.subtle。酒馆可能运行在普通 HTTP 页面，
        // 此时移动浏览器会禁用 Web Crypto，导致每张角色都在 SHA256 阶段失败。
        // CardVault 服务端写入文件时本来就会计算 SHA256，因此直接使用服务端返回值。
        const characterUpload = await apiFetch(`/api/play-archives/sessions/${encodeURIComponent(session.sessionId)}/character`, {
            method: 'PUT', headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent(character.avatar) }, body: cardBlob, timeoutMs: 120000,
        });
        const characterSha256 = String(characterUpload?.sha256 || '');

        const characterJsonBlob = new Blob([JSON.stringify(characterJson, null, 2)], { type: 'application/json' });
        const characterJsonUpload = await apiFetch(`/api/play-archives/sessions/${encodeURIComponent(session.sessionId)}/character-json`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: characterJsonBlob, timeoutMs: 120000,
        });
        const characterJsonSha256 = String(characterJsonUpload?.sha256 || '');

        let linkedWorldbookSha256 = '';
        if (linkedWorldbook) {
            const worldbookBlob = new Blob([JSON.stringify(linkedWorldbook.data, null, 2)], { type: 'application/json' });
            const worldbookUpload = await apiFetch(`/api/play-archives/sessions/${encodeURIComponent(session.sessionId)}/worldbook`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Worldbook-Name': encodeURIComponent(linkedWorldbook.name) },
                body: worldbookBlob,
                timeoutMs: 120000,
            });
            linkedWorldbookSha256 = String(worldbookUpload?.sha256 || '');
        }
        const chatManifest = [];
        for (let index = 0; index < chatFiles.length; index += 1) {
            const fileName = chatFiles[index];
            onProgress({ stage: 'chat', name: character.name, chat: fileName, current: index + 1, total: chatFiles.length });
            const blob = await exportRawChat(character, fileName);
            const uploaded = await apiFetch(`/api/play-archives/sessions/${encodeURIComponent(session.sessionId)}/chats/${encodeURIComponent(fileName)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/x-ndjson' }, body: blob, timeoutMs: 120000,
            });
            chatManifest.push({
                name: uploaded.name || fileName,
                originalName: fileName,
                sha256: String(uploaded?.sha256 || ''),
                size: Number(uploaded?.size || blob.size),
            });
        }
        const committedResult = await apiFetch(`/api/play-archives/sessions/${encodeURIComponent(session.sessionId)}/commit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedChatCount: chatFiles.length, characterSha256, characterJsonSha256, linkedWorldbookSha256, chats: chatManifest }), timeoutMs: 120000,
        });
        const archive = committedResult.archive;
        const verifyResult = await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/verify`, { timeoutMs: 120000 });
        if (!verifyResult?.ok) throw new Error('云端游玩备份二次校验未通过');
        rememberPlayArchive(character.avatar, archive);
        committed = true;
        return archive;
    } finally {
        if (!committed && session?.sessionId) {
            apiFetch(`/api/play-archives/sessions/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE', timeoutMs: 15000 }).catch(() => {});
        }
    }
}

async function getUniqueSillyTavernCharacters() {
    const ctx = context();
    if (typeof ctx.getCharacters === 'function') await ctx.getCharacters();
    const seen = new Set();
    return (Array.isArray(ctx.characters) ? ctx.characters : []).filter(character => {
        const avatar = String(character?.avatar || '').trim();
        if (!avatar || seen.has(avatar)) return false;
        seen.add(avatar); return true;
    });
}

async function deleteCharacterAndChats(character) {
    const response = await request('/api/characters/delete', {
        method: 'POST', headers: requestHeaders(), body: JSON.stringify({ avatar_url: character.avatar, delete_chats: true }),
    }, 120000);
    if (!response.ok) throw new Error(`删除酒馆角色失败：${character.name || character.avatar}（HTTP ${response.status}）`);
    forgetPlayArchiveAvatar(character.avatar);
}

async function archiveAllAndCleanup(onProgress = () => {}) {
    if (!await verify({ quiet: true })) throw new Error('请先登录 CardVault');
    await saveCurrentChatBeforeArchive();
    const characters = await getUniqueSillyTavernCharacters();
    if (!characters.length) throw new Error('酒馆里没有需要归档的角色');

    const startApproved = await cardVaultConfirm({
        title: '完整归档并清理酒馆',
        message: `即将把 ${characters.length} 张角色卡、它们的全部 JSONL 聊天、卡内世界书、Scoped Regex 和已绑定世界书归档到 CardVault。\n\n只有全部云端 SHA256 校验通过后，才会进入最后的“清理本地”确认。`,
        confirmText: '开始完整归档',
        cancelText: '取消',
    });
    if (!startApproved) {
        setStatus('已取消完整归档', 'connected');
        return { cancelled: true };
    }

    const completed = [];
    const failed = [];
    for (let index = 0; index < characters.length; index += 1) {
        const character = characters[index];
        try {
            const archive = await backupCharacterAsPlayArchive(character, detail => onProgress({ ...detail, characterIndex: index + 1, characterTotal: characters.length }));
            completed.push({ character, archive });
        } catch (error) {
            failed.push({ character, message: error?.message || '未知错误' });
            console.error('[CardVault] 游玩备份失败', character, error);
        }
    }
    if (failed.length) {
        const names = failed.slice(0, 4).map(item => item.character.name || item.character.avatar).join('、');
        const first = failed[0];
        const firstName = first?.character?.name || first?.character?.avatar || '未知角色';
        const firstMessage = first?.message || '未知错误';
        setStatus(`归档失败：成功 ${completed.length} 张，失败 ${failed.length} 张；本地未清理`, 'error');
        throw new Error(`归档未全部完成：成功 ${completed.length} 张，失败 ${failed.length} 张（${names}${failed.length > 4 ? '等' : ''}）。首个错误：${firstName}：${firstMessage}。为防止丢失，本次没有删除酒馆里的任何角色、聊天或世界书。`);
    }

    const worldbookRefs = new Map();
    for (const item of completed) {
        const worldbookName = String(item.archive?.linkedWorldbook?.name || '').trim();
        if (!worldbookName) continue;
        if (!worldbookRefs.has(worldbookName)) worldbookRefs.set(worldbookName, new Set());
        worldbookRefs.get(worldbookName).add(String(item.character.avatar));
    }
    const worldbookNames = [...worldbookRefs.keys()];

    setStatus(`云端校验完成：${completed.length}/${completed.length} 张；等待本地清理确认`, 'connected');
    const cleanupApproved = await cardVaultConfirm({
        title: '云端归档已完整完成',
        message: `全部 ${completed.length} 张角色都已上传并通过 SHA256 校验。${worldbookNames.length ? `\n同时完整备份了 ${worldbookNames.length} 本已绑定世界书。` : ''}\n\n现在是否从酒馆本地删除这些角色、它们的聊天目录，以及可安全删除的已绑定世界书？\n\nCardVault 云端游玩备份不会被删除。`,
        confirmText: '确认清理本地',
        cancelText: '只归档，不清理',
        danger: true,
    });
    if (!cleanupApproved) {
        setStatus(`云端归档已完成：${completed.length} 张；本地保留`, 'connected');
        notify('info', '云端归档已完成；你选择了“只归档，不清理”，酒馆角色、聊天和世界书仍然保留');
        return { archived: completed.length, deleted: 0, deletedWorldbooks: 0, cancelledCleanup: true };
    }

    let deleted = 0;
    const deletedAvatars = new Set();
    const deletionFailures = [];
    for (let index = 0; index < completed.length; index += 1) {
        const item = completed[index];
        try {
            onProgress({ stage: 'local-delete', name: item.character.name, current: index + 1, total: completed.length, characterIndex: index + 1, characterTotal: completed.length });
            await deleteCharacterAndChats(item.character);
            deleted += 1;
            deletedAvatars.add(String(item.character.avatar));
        } catch (error) {
            deletionFailures.push({ name: item.character.name, message: error.message });
            console.error('[CardVault] 本地角色清理失败', item.character, error);
        }
    }

    const eligibleWorldbooks = [];
    const preservedWorldbooks = [];
    for (const [worldbookName, avatars] of worldbookRefs.entries()) {
        const allLinkedCharactersDeleted = [...avatars].every(avatar => deletedAvatars.has(avatar));
        if (allLinkedCharactersDeleted) eligibleWorldbooks.push(worldbookName);
        else preservedWorldbooks.push(worldbookName);
    }

    const worldbookResult = await deleteLinkedWorldbooksFromSillyTavern(eligibleWorldbooks, detail => onProgress({ ...detail, characterIndex: completed.length, characterTotal: completed.length }));
    const warningParts = [];
    if (deletionFailures.length) warningParts.push(`${deletionFailures.length} 张本地角色删除失败`);
    if (worldbookResult.failed.length) warningParts.push(`${worldbookResult.failed.length} 本世界书删除失败`);
    if (preservedWorldbooks.length) warningParts.push(`${preservedWorldbooks.length} 本世界书因仍有本地角色引用而保留`);

    if (warningParts.length) {
        setStatus(`归档完成；已清理 ${deleted}/${completed.length} 张角色，部分本地项目清理失败`, 'error');
        notify('warning', `已清理 ${deleted} 张角色和 ${worldbookResult.deleted.length} 本已绑定世界书；${warningParts.join('，')}。云端备份均完整`);
    } else {
        setStatus(`归档完成并已清理本地：角色 ${deleted}/${completed.length}`, 'connected');
        notify('success', `已将 ${deleted} 张角色完整归档，并从酒馆清理角色、聊天和 ${worldbookResult.deleted.length} 本已绑定世界书`);
    }
    setTimeout(() => location.reload(), 800);
    return {
        archived: completed.length,
        deleted,
        deletionFailures,
        deletedWorldbooks: worldbookResult.deleted.length,
        missingWorldbooks: worldbookResult.missing,
        worldbookDeletionFailures: worldbookResult.failed,
        preservedWorldbooks,
    };
}

async function syncCurrentAndReturn(onProgress = () => {}) {
    if (!await verify({ quiet: true })) throw new Error('请先登录 CardVault');
    await saveCurrentChatBeforeArchive();
    const ctx = context();
    const character = ctx.characters?.[ctx.characterId];
    if (!character?.avatar) throw new Error('当前没有选中的角色');
    const archive = await backupCharacterAsPlayArchive(character, onProgress);
    const linkedWorldbookName = String(archive?.linkedWorldbook?.name || '').trim();
    let otherReferences = [];
    if (linkedWorldbookName) {
        otherReferences = await otherLocalCharactersUsingWorldbook(linkedWorldbookName, character.avatar);
    }
    const worldbookPlan = !linkedWorldbookName
        ? '这张角色没有独立绑定世界书。'
        : otherReferences.length
            ? `关联世界书“${linkedWorldbookName}”还被 ${otherReferences.length} 张本地角色使用，因此会保留在酒馆。`
            : `关联世界书“${linkedWorldbookName}”只供这张角色使用，将一并从酒馆删除。`;
    if (!await cardVaultConfirm({
        title: '同步已完成',
        message: `“${character.name}”已经同步到 CardVault 并通过校验。\n\n${worldbookPlan}\n\n现在删除本地角色卡和聊天，归还到云端吗？`,
        confirmText: '归还并清理本地',
        cancelText: '只同步，不清理',
        danger: true,
    })) {
        notify('success', '同步完成；本地角色、聊天和世界书仍保留');
        return archive;
    }
    await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'archived' }) });
    await deleteCharacterAndChats(character);

    let deletedWorldbook = false;
    let worldbookFailure = null;
    if (linkedWorldbookName && otherReferences.length === 0) {
        const result = await deleteLinkedWorldbooksFromSillyTavern([linkedWorldbookName], onProgress);
        deletedWorldbook = result.deleted.length > 0;
        worldbookFailure = result.failed[0] || null;
    }

    if (worldbookFailure) {
        notify('warning', `角色和聊天已归还 CardVault，但世界书“${linkedWorldbookName}”删除失败：${worldbookFailure.message}`);
    } else if (deletedWorldbook) {
        notify('success', `进度已同步，角色、聊天和世界书“${linkedWorldbookName}”已归还 CardVault`);
    } else if (linkedWorldbookName && otherReferences.length) {
        notify('success', `进度已同步，角色已归还 CardVault；共享世界书“${linkedWorldbookName}”已保留`);
    } else {
        notify('success', '进度已同步，角色已归还 CardVault');
    }
    setTimeout(() => location.reload(), 700);
    return archive;
}

async function currentLocalWorldbookReferences() {
    const characters = await getUniqueSillyTavernCharacters();
    const references = new Map();
    for (const character of characters) {
        let linkedName = linkedWorldbookNameFromCharacterJson(character);
        if (!linkedName) {
            const full = await getFullCharacterFromSillyTavern(character);
            linkedName = linkedWorldbookNameFromCharacterJson(full);
        }
        if (!linkedName) continue;
        if (!references.has(linkedName)) references.set(linkedName, []);
        references.get(linkedName).push(character);
    }
    return references;
}

async function cleanupArchivedWorldbooks(onProgress = () => {}) {
    if (!await verify({ quiet: true })) throw new Error('请先登录 CardVault');
    const result = await apiFetch('/api/play-archives', { timeoutMs: 120000 });
    const archives = (Array.isArray(result?.archives) ? result.archives : [])
        .filter(archive => archive?.complete && archive?.linkedWorldbook?.name);
    if (!archives.length) throw new Error('当前 CardVault 账号里没有带独立世界书的完整游玩备份');

    const archiveWorldbooks = new Map();
    for (let index = 0; index < archives.length; index += 1) {
        const archive = archives[index];
        onProgress({ stage: 'verify-archive-worldbook', name: archive.name, current: index + 1, total: archives.length });
        const verifyResult = await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/verify`, { timeoutMs: 120000 });
        if (!verifyResult?.ok) throw new Error(`游玩备份“${archive.name}”校验失败，为防止丢失，本次没有删除任何世界书`);
        const worldbookName = String(archive.linkedWorldbook.name || '').trim();
        if (!worldbookName) continue;
        if (!archiveWorldbooks.has(worldbookName)) archiveWorldbooks.set(worldbookName, []);
        archiveWorldbooks.get(worldbookName).push(archive.name || archive.id);
    }

    const localReferences = await currentLocalWorldbookReferences();
    const candidates = [...archiveWorldbooks.keys()].filter(name => !localReferences.has(name));
    const preserved = [...archiveWorldbooks.keys()].filter(name => localReferences.has(name));
    if (!candidates.length) {
        throw new Error(preserved.length
            ? `找到 ${preserved.length} 本已归档世界书，但它们仍被酒馆本地角色使用，因此没有删除`
            : '没有找到需要清理的残留世界书');
    }

    const cleanupApproved = await cardVaultConfirm({
        title: '清理已归档世界书',
        message: `CardVault 中找到 ${archiveWorldbooks.size} 本已归档世界书，并已重新通过云端 SHA256 校验。\n\n其中 ${candidates.length} 本已经没有本地角色引用，将从酒馆删除。${preserved.length ? `\n另有 ${preserved.length} 本仍被本地角色使用，会保留。` : ''}`,
        confirmText: '确认清理世界书',
        cancelText: '取消',
        danger: true,
    });
    if (!cleanupApproved) {
        notify('info', '已取消；酒馆世界书没有变化');
        return { cancelled: true };
    }

    const deleteResult = await deleteLinkedWorldbooksFromSillyTavern(candidates, onProgress);
    if (deleteResult.failed.length) {
        notify('warning', `已删除 ${deleteResult.deleted.length} 本残留世界书，${deleteResult.failed.length} 本删除失败；CardVault 云端备份仍完整`);
    } else {
        notify('success', `已从酒馆清理 ${deleteResult.deleted.length} 本已归档的残留世界书${preserved.length ? `；${preserved.length} 本因仍被本地角色使用而保留` : ''}`);
    }
    setTimeout(() => location.reload(), 700);
    return { ...deleteResult, preserved };
}

function parseJsonl(text, fileName) {
    const rows = String(text || '').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
        try { return JSON.parse(line); }
        catch { throw new Error(`聊天 ${fileName} 第 ${index + 1} 行不是有效 JSON`); }
    });
    if (!rows.length) throw new Error(`聊天 ${fileName} 是空文件`);
    return rows;
}

async function restorePlayArchiveToSillyTavern(archive, button, options = {}) {
    if(!options?._unifiedQueueHeld && globalThis.VVVUnifiedCore?.tasks?.run){
        return globalThis.VVVUnifiedCore.tasks.run(`CardVault恢复:${String(archive?.id||archive?.name||'角色')}`,()=>restorePlayArchiveToSillyTavern(archive,button,{...options,_unifiedQueueHeld:true}),{group:'generation-control'});
    }
    const original = button?.innerHTML || '';
    let restoredAvatar = '';
    let importedByThisAttempt = false;
    try {
        if (!await verify({ quiet: true })) throw new Error('请先登录 CardVault');

        // U1.2：游玩备份不再要求“酒馆必须为空”。同一酒馆可同时恢复任意数量角色。
        const active = await findActiveLocalArchiveCharacter(archive);
        if (active.character) {
            const ctx = context();
            if (typeof ctx.getCharacters === 'function') await ctx.getCharacters();
            const characterIndex = ctx.characters?.findIndex(item => item.avatar === active.avatar) ?? -1;
            if (characterIndex >= 0 && typeof ctx.selectCharacterById === 'function') {
                await ctx.selectCharacterById(characterIndex);
                await waitForCurrentCharacterAvatar(active.avatar);
            }
            if (!options.silentSuccess) notify('info', `“${archive.name}”已经在酒馆中，无需重复恢复`);
            if (!options.keepOverlay) closeOverlay();
            return { ok: true, alreadyActive: true, restoredAvatar: active.avatar, characterIndex };
        }

        if (!options.skipConfirm && !await cardVaultConfirm({
            title: '恢复游玩备份',
            message: `将“${archive.name}”下载到酒馆，并恢复 ${Number(archive.chatCount || 0)} 个聊天记录。\n\n酒馆现有角色会保留，可同时恢复多张游玩备份。`,
            confirmText: '下载并恢复',
            cancelText: '取消',
        })) return { cancelled: true };

        if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在准备恢复……'; }
        await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'restoring' }) });

        if (button) button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在导入角色卡……';
        const response = await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/character`, { raw: true, timeoutMs: 120000 });
        const blob = await response.blob();
        let theaterBundle = null;
        try { theaterBundle = vvvTheaterBundleFromCharacterJson(extractCharacterJsonFromPngBytes(new Uint8Array(await blob.arrayBuffer()))); } catch (error) { console.warn('[CardVault] 读取角色PNG中的0-32伴随档案失败', error); }

        const existingCharacters = active.existing || await getUniqueSillyTavernCharacters();
        const filename = chooseRestoreFilename(archive, existingCharacters);
        const form = new FormData();
        form.append('avatar', new File([blob], filename, { type: 'image/png' }));
        form.append('file_type', 'png');
        form.append('preserved_name', filename.replace(/\.png$/i, ''));
        const headers = requestHeaders(); delete headers['Content-Type']; delete headers['content-type'];
        const importResponse = await request('/api/characters/import', { method: 'POST', headers, body: form }, 120000);
        const importResult = await parseResponse(importResponse);
        if (!importResponse.ok || importResult?.error) throw new Error(importResult?.message || '角色卡导入酒馆失败');
        restoredAvatar = String(importResult?.file_name || filename);
        if (!restoredAvatar.toLowerCase().endsWith('.png')) restoredAvatar += '.png';
        importedByThisAttempt = true;

        const chats = Array.isArray(archive.chats) ? archive.chats : [];
        for (let index = 0; index < chats.length; index += 1) {
            const chat = chats[index];
            if (button) button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 恢复聊天 ${index + 1}/${chats.length}`;
            const chatResponse = await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/chats/${encodeURIComponent(chat.name)}`, { raw: true, timeoutMs: 120000 });
            const rows = parseJsonl(await chatResponse.text(), chat.originalName || chat.name);
            const fileName = String(chat.originalName || chat.name).replace(/\.jsonl$/i, '');
            const saveResponse = await request('/api/chats/save', {
                method: 'POST', headers: requestHeaders(), body: JSON.stringify({ file_name: fileName, chat: rows, avatar_url: restoredAvatar, force: true }),
            }, 120000);
            if (!saveResponse.ok) throw new Error(`恢复聊天失败：${chat.originalName || chat.name}`);
        }

        const ctx = context();
        if (typeof ctx.getCharacters === 'function') await ctx.getCharacters();
        const characterIndex = ctx.characters?.findIndex(item => item.avatar === restoredAvatar) ?? -1;

        // U1.4：先确认SillyTavern真的切到刚恢复的角色，再允许写世界书和0-32伴随档案。
        // 这样批量恢复某一项若角色索引/切换失败，不会先把共享世界书改掉，也不会把0-32写到上一张角色。
        if (characterIndex >= 0 && typeof ctx.selectCharacterById === 'function') {
            await ctx.selectCharacterById(characterIndex);
            const selectedReady = await waitForCurrentCharacterAvatar(restoredAvatar, 30000);
            if (!selectedReady) throw new Error(`角色“${archive.name}”已经导入，但酒馆30秒内没有安全切换到该角色；为避免0-32档案串到别的角色，本次自动回滚`);

            if (button) button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在恢复关联世界书……';
            await restoreLinkedWorldbookToSillyTavern(archive);

            if (theaterBundle) {
                if (button) button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在恢复0-32永久资料……';
                const bundleRestored = await restoreVvvTheaterBundleForCurrentCharacter(theaterBundle, { silent: Boolean(options.silentSuccess) });
                if (!bundleRestored && options.keepOverlay) throw new Error(`角色“${archive.name}”已导入，但0-32永久伴随档案没有成功接回；批量恢复为保证完整性，本项自动回滚`);
                if (!bundleRestored && !options.keepOverlay) sessionStorage.setItem('cardvault_pending_vvv_theater_bundle', JSON.stringify(theaterBundle));
            }
        } else {
            if (options.keepOverlay) throw new Error(`角色“${archive.name}”导入后未出现在酒馆角色索引；批量恢复为防止多份0-32伴随档案互相覆盖，已停止这一项并自动回滚`);
            // 单张恢复且旧版酒馆无法立即刷新角色索引时保留兼容兜底；世界书可以恢复，0-32留到页面刷新后接回。
            await restoreLinkedWorldbookToSillyTavern(archive);
            if (theaterBundle) sessionStorage.setItem('cardvault_pending_vvv_theater_bundle', JSON.stringify(theaterBundle));
        }

        // 只有角色/聊天/世界书/需要的0-32流程都安全完成后，才记录本地映射并把云端状态标为active。
        rememberPlayArchive(restoredAvatar, archive);
        await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'active', restoredAvatar }) });

        if (!options.silentSuccess) notify('success', `“${archive.name}”及 ${chats.length} 个聊天已恢复到酒馆`);
        if (!options.keepOverlay) closeOverlay();
        if (characterIndex < 0 && !options.keepOverlay) setTimeout(() => location.reload(), 500);
        return { ok: true, alreadyActive: false, restoredAvatar, characterIndex, chatCount: chats.length };
    } catch (error) {
        console.error('[CardVault] 恢复游玩备份失败', error);
        let rolledBack = false;
        if (importedByThisAttempt && restoredAvatar) {
            try {
                const rollback = await request('/api/characters/delete', {
                    method: 'POST', headers: requestHeaders(), body: JSON.stringify({ avatar_url: restoredAvatar, delete_chats: true }),
                }, 120000);
                rolledBack = rollback.ok;
                if (rolledBack) forgetPlayArchiveAvatar(restoredAvatar);
            } catch (rollbackError) {
                console.error('[CardVault] 恢复失败后的本地回滚也失败', rollbackError);
            }
        }
        try {
            await apiFetch(`/api/play-archives/${encodeURIComponent(archive.id)}/state`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: rolledBack ? 'archived' : 'error' }),
            });
        } catch {}
        const finalMessage = `${error.message || '恢复失败'}${rolledBack ? '；刚才导入的不完整本地副本已自动清理' : ''}`;
        if (!options.silentError) notify('error', finalMessage);
        if (options.rethrow) throw new Error(finalMessage);
        return { ok: false, error, rolledBack };
    } finally {
        if (button?.isConnected) { button.disabled = false; button.innerHTML = original; }
    }
}

async function uploadBlobToCardVault(blob, filename, mime = '') {
    return apiFetch('/api/cards/import', {
        method: 'POST',
        headers: { 'Content-Type': mime || blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(filename) },
        body: blob,
        timeoutMs: 120000,
    });
}

async function uploadLocalFiles(files) {
    if (!await verify({ quiet: true })) throw new Error('请先登录 CardVault');
    const accepted = [...files].filter(file => /\.(png|json)$/i.test(file.name));
    if (!accepted.length) throw new Error('请选择 PNG 或 JSON 角色卡');
    let imported = 0;
    let duplicate = 0;
    for (const file of accepted) {
        const result = await uploadBlobToCardVault(file, file.name, file.type);
        if (result?.duplicate) duplicate += 1; else imported += 1;
    }
    notify('success', `上传完成：新增 ${imported} 张，重复 ${duplicate} 张`);
    if (document.querySelector('.cv-overlay')) await loadCards(document.querySelector('#cv_library_search')?.value || '');
}

async function renderSettingsTemplate() {
    const response = await fetch(new URL('./settings.html', import.meta.url), { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`无法加载 CardVault 设置页面：HTTP ${response.status}`);
    }
    return response.text();
}

function bindSettings() {
    const cfg = extensionSettings();
    cfg.apiUrl = cleanBase(cfg.apiUrl || DEFAULT_SETTINGS.apiUrl);
    cfg.username = String(cfg.username || DEFAULT_SETTINGS.username || 'card2').trim() || 'card2';
    refreshAuthIdentity();
    saveSettings();

    const apiUrlInput = document.querySelector('#cv_api_url');
    const usernameInput = document.querySelector('#cv_username');
    const preferProxyInput = document.querySelector('#cv_prefer_proxy');
    const passwordInput = document.querySelector('#cv_password');
    const passwordToggle = document.querySelector('#cv_password_toggle');
    const reconnectButton = document.querySelector('#cv_reconnect');
    const boundAccount = document.querySelector('#cv_bound_account');
    const policyHelp = document.querySelector('#cv_policy_help');
    const classifierApiUrlInput = document.querySelector('#cv_classifier_api_url');
    const classifierApiKeyInput = document.querySelector('#cv_classifier_api_key');
    const classifierApiKeyToggle = document.querySelector('#cv_classifier_api_key_toggle');
    const classifierModelInput = document.querySelector('#cv_classifier_model');
    const classifierModelManualInput = document.querySelector('#cv_classifier_model_manual');
    const classifierFetchModelsButton = document.querySelector('#cv_classifier_fetch_models');
    const classifierSaveButton = document.querySelector('#cv_classifier_save');
    const classifierStatus = document.querySelector('#cv_classifier_status');
    const authCard = document.querySelector('.cv-auth-card');

    if (authCard) authCard.style.display = '';
    if (apiUrlInput) apiUrlInput.value = cfg.apiUrl || '';
    if (usernameInput) usernameInput.value = cfg.username || 'card2';
    if (preferProxyInput) preferProxyInput.checked = cfg.preferServerProxy !== false;

    const renderAccountIdentity = () => {
        const live = extensionSettings();
        const username = String(live.username || 'card2').trim() || 'card2';
        const label = accountDisplayName(username);
        const isXAccount = username === 'card2' || username === 'x';
        if (policyHelp) {
            policyHelp.textContent = `独立版 CardVault：酒馆账号 ${sillyTavernUserHandle || 'unknown'} 与云端卡库分离。可直接登录，也可在检测到现有 VVV 同源代理时优先复用代理。`;
        }
        if (boundAccount) {
            boundAccount.dataset.account = username;
            boundAccount.innerHTML = `
              <span class="cv-account-icon"><i class="fa-solid ${isXAccount ? 'fa-user-lock' : 'fa-crown'}"></i></span>
              <span class="cv-account-copy"><b>${escapeHtml(label)}</b><small>当前云端账号：${escapeHtml(username)}</small></span>
              <span class="cv-account-check"><i class="fa-solid fa-cloud"></i></span>`;
        }
        if (passwordInput) passwordInput.placeholder = `输入 ${label} 卡库密码（不会保存密码）`;
    };
    renderAccountIdentity();

    const persistConnectionFields = () => {
        const live = extensionSettings();
        if (apiUrlInput) live.apiUrl = cleanBase(apiUrlInput.value || DEFAULT_SETTINGS.apiUrl);
        if (usernameInput) live.username = String(usernameInput.value || DEFAULT_SETTINGS.username).trim() || DEFAULT_SETTINGS.username;
        if (preferProxyInput) live.preferServerProxy = !!preferProxyInput.checked;
        refreshAuthIdentity();
        verifiedTokenAccount = '';
        cardVaultTransportMode = 'direct';
        cardVaultProxyReady = false;
        saveSettings();
        renderAccountIdentity();
        setStatus(`连接配置已更新 · ${accountDisplayName(live.username)}`, 'idle');
        return live;
    };
    if (apiUrlInput) apiUrlInput.onchange = () => { try { persistConnectionFields(); } catch (error) { notify('error', error.message); } };
    if (usernameInput) usernameInput.onchange = () => { try { persistConnectionFields(); } catch (error) { notify('error', error.message); } };
    if (preferProxyInput) preferProxyInput.onchange = () => { try { persistConnectionFields(); } catch (error) { notify('error', error.message); } };

    const renderClassifierModels = () => {
        if (!classifierModelInput) return;
        const models = Array.isArray(cfg.classifierModels) ? cfg.classifierModels : [];
        const current = String(cfg.classifierModel || '').trim();
        const options = ['<option value="">请选择分类模型</option>'];
        if (current && !models.includes(current)) options.push(`<option value="${escapeHtml(current)}">${escapeHtml(current)}（当前/手动）</option>`);
        options.push(...models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`));
        classifierModelInput.innerHTML = options.join('');
        classifierModelInput.value = current;
        if (classifierModelManualInput) classifierModelManualInput.value = current && !models.includes(current) ? current : '';
    };
    const setClassifierStatus = (text, state = 'idle') => {
        if (!classifierStatus) return;
        classifierStatus.textContent = text;
        classifierStatus.dataset.state = state;
    };
    if (classifierApiUrlInput) classifierApiUrlInput.value = cfg.classifierApiUrl || '';
    if (classifierApiKeyInput) classifierApiKeyInput.value = cfg.classifierApiKey || '';
    renderClassifierModels();
    setClassifierStatus(cfg.classifierModel
        ? `当前分类模型：${cfg.classifierModel} · 分类请求与聊天主 API 完全分离`
        : '尚未配置独立分类模型；填写 API 地址和 Key 后点击“拉取模型”', cfg.classifierModel ? 'ok' : 'idle');

    const persistClassifierFields = () => {
        // 0.4.27：每次都写入当前 live settings；即使酒馆热重载过设置页，也不会写到旧 cfg。
        const liveCfg = extensionSettings();
        if (classifierApiUrlInput) liveCfg.classifierApiUrl = classifierApiUrlInput.value.trim();
        if (classifierApiKeyInput) liveCfg.classifierApiKey = classifierApiKeyInput.value.trim();
        const manualModel = classifierModelManualInput?.value.trim() || '';
        const selectedModel = classifierModelInput?.value.trim() || '';
        liveCfg.classifierModel = manualModel || selectedModel;
        saveSettings();
        return liveCfg;
    };

    // 用 DOM 属性事件替代重复 addEventListener。bindSettings 即使意外执行多次，也只保留最后一份监听器。
    if (classifierApiUrlInput) classifierApiUrlInput.onchange = persistClassifierFields;
    if (classifierApiKeyInput) classifierApiKeyInput.onchange = persistClassifierFields;
    if (classifierModelInput) classifierModelInput.onchange = () => {
        if (classifierModelManualInput) classifierModelManualInput.value = '';
        const liveCfg = persistClassifierFields();
        setClassifierStatus(liveCfg.classifierModel
            ? `当前分类模型：${liveCfg.classifierModel} · 分类请求与聊天主 API 完全分离`
            : '尚未选择分类模型', liveCfg.classifierModel ? 'ok' : 'idle');
    };
    if (classifierModelManualInput) classifierModelManualInput.onchange = () => {
        const liveCfg = persistClassifierFields();
        setClassifierStatus(liveCfg.classifierModel
            ? `当前分类模型：${liveCfg.classifierModel} · 分类请求与聊天主 API 完全分离`
            : '尚未选择分类模型', liveCfg.classifierModel ? 'ok' : 'idle');
    };
    if (classifierApiKeyToggle) classifierApiKeyToggle.onclick = () => {
        if (!classifierApiKeyInput) return;
        const showing = classifierApiKeyInput.type === 'text';
        classifierApiKeyInput.type = showing ? 'password' : 'text';
        classifierApiKeyToggle.innerHTML = showing ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
        classifierApiKeyToggle.title = showing ? '显示 API Key' : '隐藏 API Key';
    };
    if (classifierSaveButton) classifierSaveButton.onclick = () => {
        try {
            const liveCfg = persistClassifierFields();
            if (liveCfg.classifierApiUrl) {
                liveCfg.classifierApiUrl = normalizeClassifierApiBase(liveCfg.classifierApiUrl);
                if (classifierApiUrlInput) classifierApiUrlInput.value = liveCfg.classifierApiUrl;
            }
            saveSettings();
            setClassifierStatus(liveCfg.classifierModel
                ? `配置已保存：${liveCfg.classifierModel} · 不会调用聊天主 API`
                : '配置已保存；还需要选择模型', liveCfg.classifierModel ? 'ok' : 'idle');
            notify('success', 'CardVault 独立分类 API 配置已保存');
        } catch (error) {
            setClassifierStatus(error.message, 'error');
            notify('error', error.message);
        }
    };
    if (classifierFetchModelsButton) classifierFetchModelsButton.onclick = async () => {
        // 先从当前可见输入框强制同步，再读取配置。避免 UI 有值、配置对象为空。
        const liveCfg = persistClassifierFields();
        const typedBase = normalizeClassifierApiBase(liveCfg.classifierApiUrl);
        if (!typedBase) {
            setClassifierStatus('请先填写独立分类 API 地址', 'error');
            notify('error', '请先填写独立分类 API 地址');
            return;
        }
        liveCfg.classifierApiUrl = typedBase;
        if (classifierApiUrlInput) classifierApiUrlInput.value = typedBase;
        saveSettings();

        const original = classifierFetchModelsButton.innerHTML;
        classifierFetchModelsButton.disabled = true;
        classifierFetchModelsButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 拉取中';
        try {
            setClassifierStatus('正在从独立 API 拉取模型列表……', 'loading');
            const models = await fetchClassifierModels();
            renderClassifierModels();
            const currentCfg = classifierConfig();
            setClassifierStatus(`已拉取 ${models.length} 个模型；当前：${currentCfg.classifierModel}`, 'ok');
            notify('success', `已拉取 ${models.length} 个分类模型`);
        } catch (error) {
            setClassifierStatus(error.message, 'error');
            notify('error', error.message);
        } finally {
            classifierFetchModelsButton.disabled = false;
            classifierFetchModelsButton.innerHTML = original;
        }
    };

    passwordToggle?.addEventListener('click', () => {
        if (!passwordInput) return;
        const showing = passwordInput.type === 'text';
        passwordInput.type = showing ? 'password' : 'text';
        passwordToggle.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
        passwordToggle.title = showing ? '显示密码' : '隐藏密码';
        passwordToggle.innerHTML = showing
            ? '<i class="fa-solid fa-eye"></i>'
            : '<i class="fa-solid fa-eye-slash"></i>';
        passwordInput.focus();
    });

    const submitLogin = () => {
        try { persistConnectionFields(); } catch (error) { setStatus(error.message, 'error'); notify('error', error.message); return; }
        login(passwordInput?.value || '').catch(error => {
            setStatus(error.message, 'error');
            notify('error', error.message);
        });
    };

    reconnectButton?.addEventListener('click', submitLogin);
    passwordInput?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitLogin();
        }
    });

    document.querySelector('#cv_forget')?.addEventListener('click', () => {
        if (!globalThis.confirm(`确定清除 ${accountDisplayName(extensionSettings().username)} 卡库在这台浏览器保存的登录状态吗？`)) return;
        disconnect();
    });
    document.querySelector('#cv_open')?.addEventListener('click', () => openLibrary().catch(error => notify('error', error.message)));
    document.querySelector('#cv_backup_current')?.addEventListener('click', event => {
        const button = event.currentTarget;
        const original = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在备份……';
        backupCurrentCharacter().catch(error => notify('error', error.message)).finally(() => {
            button.disabled = false;
            button.innerHTML = original;
        });
    });
    document.querySelector('#cv_backup_all')?.addEventListener('click', event => {
        const button = event.currentTarget;
        const original = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在读取角色列表……';
        backupAllCharacters(({ current, total, name }) => {
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${current}/${total} ${escapeHtml(name)}`;
        }).catch(error => notify('error', error.message)).finally(() => {
            button.disabled = false;
            button.innerHTML = original;
        });
    });
    document.querySelector('#cv_archive_all_cleanup')?.addEventListener('click', event => {
        const button = event.currentTarget; const original = button.innerHTML;
        button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在准备完整归档……';
        archiveAllAndCleanup(progress => {
            const charPart = `${progress.characterIndex || 0}/${progress.characterTotal || 0}`;
            const detailPart = progress.stage === 'chat'
                ? ` · 聊天 ${progress.current}/${progress.total}`
                : progress.stage === 'worldbook-delete'
                    ? ` · 清理世界书 ${progress.current}/${progress.total}`
                    : progress.stage === 'local-delete'
                        ? ` · 清理本地角色 ${progress.current}/${progress.total}`
                        : '';
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 角色 ${charPart}${detailPart} ${escapeHtml(progress.name || '')}`;
            setStatus(`完整归档中：角色 ${charPart}${detailPart} ${progress.name || ''}`, 'loading');
        }).catch(error => { setStatus(error.message, 'error'); notify('error', error.message); }).finally(() => {
            if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
        });
    });
    document.querySelector('#cv_cleanup_archived_worldbooks')?.addEventListener('click', event => {
        const button = event.currentTarget; const original = button.innerHTML;
        button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在核对云端世界书……';
        cleanupArchivedWorldbooks(progress => {
            const verb = progress.stage === 'verify-archive-worldbook' ? '校验' : '清理';
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${verb} ${progress.current}/${progress.total} ${escapeHtml(progress.name || '')}`;
        }).catch(error => { setStatus(error.message, 'error'); notify('error', error.message); }).finally(() => {
            if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
        });
    });
    document.querySelector('#cv_sync_return_current')?.addEventListener('click', event => {
        const button = event.currentTarget; const original = button.innerHTML;
        button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在同步当前角色……';
        syncCurrentAndReturn(progress => {
            const chatPart = progress.stage === 'chat' ? `聊天 ${progress.current}/${progress.total}` : '角色卡';
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 正在同步${chatPart}`;
        }).catch(error => notify('error', error.message)).finally(() => {
            if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
        });
    });
    document.querySelector('#cv_upload_local')?.addEventListener('click', () => document.querySelector('#cv_upload_input')?.click());
    document.querySelector('#cv_upload_input')?.addEventListener('change', event => {
        uploadLocalFiles(event.target.files).catch(error => notify('error', error.message)).finally(() => {
            event.target.value = '';
        });
    });
}

async function tryRestorePendingVvvTheaterBundle() {
    const raw = sessionStorage.getItem('cardvault_pending_vvv_theater_bundle');
    if (!raw) return;
    let bundle = null;
    try { bundle = JSON.parse(raw); } catch { sessionStorage.removeItem('cardvault_pending_vvv_theater_bundle'); return; }
    const ok = await restoreVvvTheaterBundleForCurrentCharacter(bundle);
    if (ok) sessionStorage.removeItem('cardvault_pending_vvv_theater_bundle');
}

async function initialize() {
    if (initialized) return;
    initialized = true;
    try {
        extensionSettings();
        await loadSillyTavernAccount();
        installInteractiveCardFallbacks();
        removeCardVaultUi();
        getSessionToken();
        const html = await renderSettingsTemplate();
        const container = document.querySelector('#extensions_settings');
        if (!container) throw new Error('找不到酒馆扩展设置区域');
        container.insertAdjacentHTML('beforeend', html);
        bindSettings();
        const verified = await verify({ quiet: true });
        installImportGuardian();
        void tryRestorePendingVvvTheaterBundle().catch(error => console.warn('[CardVault] 延迟恢复0-32伴随档案失败', error));
        if (verified) {
            void refreshCardListFromServer().catch(error => console.warn('[CardVault] background card-list warmup skipped', error));
            void runImportGuardianSweep({ force: true });
        }
        console.info(`[CardVault] Standalone 1.0.0 loaded: ST ${sillyTavernUserHandle} -> ${accountDisplayName(requiredCardVaultAccount())}; transport=${cardVaultTransportMode}`);
    } catch (error) {
        initialized = false;
        console.error('[CardVault] Initialization failed', error);
        notify('error', `CardVault 扩展加载失败：${error.message}`);
    }
}

function handleEscape(event) {
    if (event.key === 'Escape' && document.querySelector('.cv-overlay')) closeOverlay();
}

document.addEventListener('keydown', handleEscape);


// Optional compatibility bridge: standalone CardVault can still be opened by an existing VVV shell if present.
globalThis.VVVUnifiedCardVault = Object.assign(globalThis.VVVUnifiedCardVault || {}, {
    version: '1.0.0-standalone',
    open: async () => { if (!initialized) await initialize(); return openLibrary(); },
    close: () => closeOverlay(),
    verify: (opts={quiet:true}) => verify(opts),
    restorePlayArchiveToSillyTavern: (archive, button) => restorePlayArchiveToSillyTavern(archive, button),
});

export async function onActivate() {
    globalThis.VVVUnifiedCore?.overlays?.register?.('cardvault',{close:closeOverlay});
    await initialize();
}

export function onDisable() {
    removeCardVaultUi();
    for(const cleanup of importGuardianCleanups.splice(0)){try{cleanup();}catch(_){}}
    initialized = false;
}

export async function onClean() {
    setSessionToken('');
    try {
        const root = context().extensionSettings || globalThis.extension_settings;
        if (root) delete root[EXTENSION_NAME];
        saveSettings();
    } catch { /* no-op */ }
}

// Compatibility with older SillyTavern versions that do not invoke lifecycle hooks.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initialize(), { once: true });
else queueMicrotask(() => initialize());
