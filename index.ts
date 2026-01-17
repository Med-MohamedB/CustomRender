/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, SettingsStore } from "@api/Settings";
import * as Styles from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { makeRange, OptionType, StartAt } from "@utils/types";

const settings = definePluginSettings({
    active: {
        type: OptionType.BOOLEAN,
        description: "Enable DOM throttling",
        default: true
    },
    startDelayMs: {
        type: OptionType.SLIDER,
        description: "Delay after app mount is ready before throttling",
        markers: makeRange(0, 5000, 500),
        default: 1200,
        stickToMarkers: false
    },
    frameBudgetMs: {
        type: OptionType.SLIDER,
        description: "Maximum CPU time per frame",
        markers: makeRange(1, 16, 1),
        default: 6,
        stickToMarkers: true
    },
    maxOpsPerFrame: {
        type: OptionType.SLIDER,
        description: "Maximum elements revealed per frame",
        markers: makeRange(20, 1000, 100),
        default: 200,
        stickToMarkers: false
    },
    indicator: {
        type: OptionType.BOOLEAN,
        description: "Show indicator in window controls",
        default: true
    }
});

const PENDING_CLASS = "dom-vsync-pending";
const INDICATOR_CLASS = "dom-vsync-indicator";
const INDICATOR_ENABLED_CLASS = "dom-vsync-enabled";
const INDICATOR_DISABLED_CLASS = "dom-vsync-disabled";
const INDICATOR_FLUSHING_CLASS = "dom-vsync-flushing";
const INDICATOR_ID = "dom-vsync-indicator";
const IGNORE_ATTR = "data-dom-vsync-ignore";
const QUEUE_LIMIT = 4000;
const EXCLUDED_TAGS = new Set([
    "HTML",
    "HEAD",
    "BODY",
    "STYLE",
    "SCRIPT",
    "LINK",
    "META"
]);

let styleEl: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let rafId = 0;
let pollTimer: number | null = null;
let startDelayTimer: number | null = null;
let indicatorPollTimer: number | null = null;
let appMount: HTMLElement | null = null;
let pendingQueue: Element[] = [];
const pendingSet = new Set<Element>();
let indicatorEl: HTMLButtonElement | null = null;
let isFlushing = false;
let isStopped = false;
let activeListener: ((value: boolean) => void) | null = null;
let indicatorListener: ((value: boolean) => void) | null = null;

function ensureStyle() {
    if (styleEl) return;

    const styleRoot = Styles.managedStyleRootNode ?? Styles.userStyleRootNode ?? document.head;
    styleEl = createAndAppendStyle("dom-vsync-style", styleRoot as HTMLElement);
    styleEl.textContent = `
.${PENDING_CLASS} {
    visibility: hidden;
}

.${INDICATOR_CLASS} {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--background-modifier-accent);
    background: var(--text-muted);
    margin: 0 6px;
    padding: 0;
    display: inline-block;
    align-self: center;
    cursor: pointer;
    box-sizing: border-box;
    -webkit-app-region: no-drag;
}

.${INDICATOR_ENABLED_CLASS} {
    background: var(--status-positive);
}

.${INDICATOR_DISABLED_CLASS} {
    background: var(--text-muted);
}

.${INDICATOR_FLUSHING_CLASS} {
    background: var(--status-positive);
    animation: dom-vsync-pulse 1s ease-in-out infinite;
}

@keyframes dom-vsync-pulse {
    0% {
        transform: scale(1);
        opacity: 1;
    }
    50% {
        transform: scale(1.35);
        opacity: 0.6;
    }
    100% {
        transform: scale(1);
        opacity: 1;
    }
}
`;
}

function updateIndicatorState() {
    if (!indicatorEl) return;

    const active = settings.store.active;

    indicatorEl.classList.toggle(INDICATOR_DISABLED_CLASS, !active);
    indicatorEl.classList.toggle(INDICATOR_ENABLED_CLASS, active && !isFlushing);
    indicatorEl.classList.toggle(INDICATOR_FLUSHING_CLASS, active && isFlushing);

    const label = !active
        ? "DOM VSync disabled"
        : isFlushing
            ? "DOM VSync enabled (flushing)"
            : "DOM VSync enabled";

    indicatorEl.setAttribute("aria-label", label);
    indicatorEl.title = label;
}

function findToolbarItem(element: Element, toolbar: HTMLElement) {
    let current: HTMLElement | null = element as HTMLElement;
    while (current && current.parentElement !== toolbar) {
        current = current.parentElement;
    }
    return current;
}

function findIndicatorContainer(): { container: HTMLElement; before?: Element | null; } | null {
    const scope: ParentNode = appMount ?? document;
    const helpButton = scope.querySelector("[aria-label='Help']") as HTMLElement | null;
    if (helpButton) {
        const toolbar = helpButton.closest("div[class*='toolbar']") as HTMLElement | null;
        if (toolbar) {
            const item = findToolbarItem(helpButton, toolbar);
            return { container: toolbar, before: item ?? null };
        }
    }

    const inboxButton = scope.querySelector("[aria-label='Inbox']") as HTMLElement | null;
    if (inboxButton) {
        const toolbar = inboxButton.closest("div[class*='toolbar']") as HTMLElement | null;
        if (toolbar) {
            const item = findToolbarItem(inboxButton, toolbar);
            return { container: toolbar, before: item ?? null };
        }
    }

    const toolbar = scope.querySelector("div[class*='toolbar']") as HTMLElement | null;
    if (toolbar) return { container: toolbar };

    return null;
}

function ensureIndicator() {
    if (!settings.store.indicator) {
        removeIndicator();
        return;
    }

    const target = findIndicatorContainer();
    if (!target) return;

    if (!indicatorEl) {
        indicatorEl = document.createElement("button");
        indicatorEl.id = INDICATOR_ID;
        indicatorEl.type = "button";
        indicatorEl.className = INDICATOR_CLASS;
        indicatorEl.setAttribute(IGNORE_ATTR, "true");
        indicatorEl.addEventListener("mousedown", (event) => {
            event.stopPropagation();
        });
        indicatorEl.addEventListener("click", (event) => {
            event.stopPropagation();
            event.preventDefault();
            settings.store.active = !settings.store.active;
        });
    }

    if (indicatorEl.parentElement !== target.container) {
        if (target.before) {
            target.container.insertBefore(indicatorEl, target.before);
        } else {
            target.container.appendChild(indicatorEl);
        }
    }

    updateIndicatorState();
}

function startIndicatorPolling() {
    if (indicatorPollTimer !== null) return;

    indicatorPollTimer = window.setInterval(() => {
        if (isStopped) return;

        if (!settings.store.indicator) {
            stopIndicatorPolling();
            removeIndicator();
            return;
        }

        ensureIndicator();
    }, 2000);
}

function stopIndicatorPolling() {
    if (indicatorPollTimer === null) return;

    clearInterval(indicatorPollTimer);
    indicatorPollTimer = null;
}

function removeIndicator() {
    if (!indicatorEl) return;

    indicatorEl.remove();
    indicatorEl = null;
}

function setFlushing(next: boolean) {
    if (isFlushing === next) return;

    isFlushing = next;
    updateIndicatorState();
}

function revealAllPending() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
    }

    for (const el of pendingSet) {
        el.classList.remove(PENDING_CLASS);
    }

    pendingSet.clear();
    pendingQueue = [];
    setFlushing(false);
}

function scheduleFlush() {
    if (!settings.store.active) return;
    if (rafId || pendingQueue.length === 0) return;

    rafId = requestAnimationFrame(flushQueue);
    setFlushing(true);
}

function flushQueue() {
    rafId = 0;

    if (!settings.store.active) {
        revealAllPending();
        return;
    }

    if (pendingQueue.length === 0) {
        setFlushing(false);
        return;
    }

    const maxOps = settings.store.maxOpsPerFrame;
    const frameBudgetMs = settings.store.frameBudgetMs;
    const start = performance.now();
    let ops = 0;

    while (pendingQueue.length > 0) {
        const el = pendingQueue.pop()!;
        pendingSet.delete(el);
        el.classList.remove(PENDING_CLASS);
        ops += 1;

        if (ops >= maxOps) break;
        if (performance.now() - start >= frameBudgetMs) break;
    }

    if (pendingQueue.length > 0) {
        scheduleFlush();
    } else {
        setFlushing(false);
    }
}

function shouldSkipElement(element: Element) {
    if (element.id === "app-mount") return true;
    if (EXCLUDED_TAGS.has(element.tagName)) return true;
    return false;
}

function enqueueElement(element: Element) {
    if (pendingSet.has(element)) return;

    element.classList.add(PENDING_CLASS);
    pendingSet.add(element);
    pendingQueue.push(element);
}

function enqueueTree(node: Node) {
    if (!settings.store.active) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const root = node as Element;

    if (root.closest(`[${IGNORE_ATTR}]`)) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(currentNode) {
            const element = currentNode as Element;

            if (shouldSkipElement(element)) return NodeFilter.FILTER_SKIP;
            if (element.hasAttribute(IGNORE_ATTR)) return NodeFilter.FILTER_REJECT;

            return NodeFilter.FILTER_ACCEPT;
        }
    });

    let current = walker.currentNode as Element | null;
    while (current) {
        enqueueElement(current);
        current = walker.nextNode() as Element | null;
    }

    if (pendingQueue.length >= QUEUE_LIMIT) {
        revealAllPending();
        return;
    }

    scheduleFlush();
}

function handleMutations(mutations: MutationRecord[]) {
    if (!settings.store.active) return;

    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            enqueueTree(node);
        }
    }
}

function startObserver() {
    if (!appMount || observer) return;

    observer = new MutationObserver(handleMutations);
    observer.observe(appMount, {
        childList: true,
        subtree: true
    });
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
}

function isAppMountReady() {
    const mount = document.getElementById("app-mount") as HTMLElement | null;

    if (mount && mount.children.length > 0) {
        appMount = mount;
        return true;
    }

    return false;
}

function scheduleThrottleStart() {
    if (isStopped) return;

    if (startDelayTimer !== null) {
        clearTimeout(startDelayTimer);
        startDelayTimer = null;
    }

    const delay = settings.store.startDelayMs;
    startDelayTimer = window.setTimeout(() => {
        startDelayTimer = null;
        if (isStopped) return;
        startObserver();
    }, delay);
}

function onAppMountReady() {
    ensureStyle();
    if (settings.store.indicator) {
        startIndicatorPolling();
        ensureIndicator();
    }
    updateIndicatorState();
    scheduleThrottleStart();
}

function waitForAppMount() {
    if (isStopped) return;

    if (isAppMountReady()) {
        onAppMountReady();
        return;
    }

    if (pollTimer !== null) return;

    pollTimer = window.setInterval(() => {
        if (isStopped) return;

        if (isAppMountReady()) {
            clearInterval(pollTimer!);
            pollTimer = null;
            onAppMountReady();
        }
    }, 250);
}

function registerSettingsListeners() {
    const pluginName = settings.pluginName;
    if (!pluginName) return;

    const activePath = `plugins.${pluginName}.active`;
    const indicatorPath = `plugins.${pluginName}.indicator`;

    activeListener = (value: boolean) => {
        if (!value) {
            revealAllPending();
        } else {
            scheduleFlush();
        }

        updateIndicatorState();
    };

    indicatorListener = (value: boolean) => {
        if (value) {
            startIndicatorPolling();
            ensureIndicator();
        } else {
            stopIndicatorPolling();
            removeIndicator();
        }

        updateIndicatorState();
    };

    SettingsStore.addChangeListener(activePath, activeListener);
    SettingsStore.addChangeListener(indicatorPath, indicatorListener);
}

function unregisterSettingsListeners() {
    const pluginName = settings.pluginName;
    if (!pluginName) return;

    if (activeListener) {
        SettingsStore.removeChangeListener(`plugins.${pluginName}.active`, activeListener);
        activeListener = null;
    }

    if (indicatorListener) {
        SettingsStore.removeChangeListener(`plugins.${pluginName}.indicator`, indicatorListener);
        indicatorListener = null;
    }
}

export default definePlugin({
    name: "CustomRender",
    description: "Smooths Discord rendering by hiding newly added DOM nodes and revealing them over multiple frames to avoid large UI spikes. Recommended: keep startDelayMs around 1000-1500, frameBudgetMs at 4-8, and maxOpsPerFrame at 150-300 for stable performance on most PCs.",
    authors: [
        { name: "m7i1", id: 741416289423065088n },
        { name: "jx5_", id: 1024297429127933952n }
    ],
    startAt: StartAt.DOMContentLoaded,
    settings,

    start() {
        isStopped = false;
        registerSettingsListeners();
        waitForAppMount();
    },

    stop() {
        isStopped = true;
        unregisterSettingsListeners();
        stopObserver();
        revealAllPending();
        removeIndicator();
        stopIndicatorPolling();

        if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        if (startDelayTimer !== null) {
            clearTimeout(startDelayTimer);
            startDelayTimer = null;
        }

        styleEl?.remove();
        styleEl = null;
        appMount = null;
    }
});
