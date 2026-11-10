/*
 * Facebook's `replaceNativeTimer` swaps the page's timer functions for its own
 * wrappers once its bundles load. Chatpane's scripts run before that, so a
 * timer they start gets a native id that Facebook's clearInterval and
 * clearTimeout ignore: a poll meant to stop after its first hit kept running
 * and, for reactions, subscribed again every tick until one reaction was
 * announced hundreds of times.
 *
 * inject/build.ts routes every timer call in the page bundles (bare and
 * `window.`) to these: the functions as they were before Facebook loaded.
 */
const page = window;

export const setTimeout: typeof window.setTimeout = page.setTimeout.bind(page);
export const clearTimeout: typeof window.clearTimeout = page.clearTimeout.bind(page);
export const setInterval: typeof window.setInterval = page.setInterval.bind(page);
export const clearInterval: typeof window.clearInterval = page.clearInterval.bind(page);
