/** Scan each connected subtree once, even when a batch includes its descendants. */
export function connectedRoots(roots: ReadonlySet<Element>): Element[] {
  return [...roots].filter((root) => {
    if (!root.isConnected) return false;
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      if (roots.has(parent)) return false;
    }
    return true;
  });
}
