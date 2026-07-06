/* ----------------------------- Spell check ---------------------------- */
import { registerAddedNodeSweep } from "./download-anchors";

const SPELL_SEL = '[contenteditable="true"], textarea, input[type="text"], input[type="search"]';

function applySpellcheckNow() {
  const on = window.__CARRIER_SETTINGS__?.spellcheck !== false;
  document.querySelectorAll(SPELL_SEL).forEach((el) => {
    el.setAttribute?.("spellcheck", on ? "true" : "false");
  });
}

function applySpellcheck() {
  applySpellcheckNow();
  // New editable surfaces are caught by the shared added-node sweep.
  registerAddedNodeSweep((root) => {
    const on = window.__CARRIER_SETTINGS__?.spellcheck !== false;
    const want = on ? "true" : "false";
    const set = (el: Element) => {
      if (el.getAttribute?.("spellcheck") !== want) el.setAttribute?.("spellcheck", want);
    };
    if (root.matches?.(SPELL_SEL)) set(root);
    root.querySelectorAll?.(SPELL_SEL).forEach(set);
  });
}

export function initSpellcheck() {
  // Re-apply when the Rust side pushes updated settings at runtime (no reload).
  window.addEventListener("carrier:settings", applySpellcheckNow);
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", applySpellcheck);
  else applySpellcheck();
}
