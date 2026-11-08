/** The chat-theme gradient Messenger declares on a chat's color host. */
export const GRADIENT_VAR = "--chat-outgoing-message-background-gradient";

const BUBBLE_COLOUR = /^var\(--chat-outgoing-message-bubble-background-color[,)]/;
const SINGLE_CLASS = /^\.[\w-]+$/;

/** The parts of a CSS rule this reads. */
export interface RuleLike {
  selectorText?: string;
  style?: { getPropertyValue(name: string): string };
  cssRules?: ArrayLike<unknown>;
}

/**
 * Add the selectors of Messenger's atomic classes that color your bubbles
 * with the chat's outgoing color (`.x… { background-color:
 * var(--chat-outgoing-message-bubble-background-color) }`) to `into`. Grouping
 * rules (media, supports) are searched too.
 */
export function collectBubbleClasses(rules: ArrayLike<unknown>, into: Set<string>): void {
  for (let index = 0; index < rules.length; index++) {
    // A CSSRule; style and grouping rules carry these properties.
    const rule = rules[index] as RuleLike | undefined;
    if (!rule) continue;
    if (rule.cssRules && !rule.selectorText) {
      collectBubbleClasses(rule.cssRules, into);
      continue;
    }
    const selector = rule.selectorText ?? "";
    if (!SINGLE_CLASS.test(selector)) continue;
    const colour = rule.style?.getPropertyValue("background-color").replace(/\s/g, "") ?? "";
    if (BUBBLE_COLOUR.test(colour)) into.add(selector);
  }
}

/**
 * Bubbles carrying those classes paint the chat's gradient themselves, fixed
 * to the window as the chat's box paints it, and the box goes without. With
 * no gradient under them, rows WebKit hasn't painted yet during a fast scroll
 * no longer flash the gradient. The box rule has no specificity, so a theme
 * that paints the box still wins; a theme that sets the gradient to `initial`
 * leaves its bubbles their own color.
 */
export function chatGradientCss(bubbleClasses: readonly string[]): string {
  if (!bubbleClasses.length) return "";
  const chat = `html[data-carrier-chats] [role="main"] [style*="${GRADIENT_VAR}"]`;
  return `${chat} :is(${bubbleClasses.join(", ")}) {
  background-image: var(${GRADIENT_VAR}) !important;
  background-attachment: fixed !important;
}
:where(${chat}:is([style*="background-image: linear-gradient"], [style*="background-image:linear-gradient"])) {
  background-image: none !important;
}
`;
}
