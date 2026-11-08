/*
 * Loads Facebook modules on demand through the page's own Bootloader, for
 * code Messenger only fetches when one of its dialogs first opens.
 */

export type Load = (name: string) => unknown;

interface Bootloader {
  loadModules(names: string[], callback: () => void, ref: string): unknown;
}

/** The page's module `require`, or null before Facebook's runtime exists. */
export function pageRequire(): Load | null {
  const load = (window as unknown as { require?: unknown }).require;
  return typeof load === "function" ? (load as Load) : null;
}

/** A module's default export when it has one, else the module itself. */
export function defaultExport(module: unknown): unknown {
  if (module && typeof module === "object" && "default" in module) {
    return (module as { default: unknown }).default;
  }
  return module;
}

/**
 * Loads `names` and returns them in order. Rejects when the loader is missing
 * or a module never arrives (a name Facebook dropped never calls back).
 */
export function loadFacebookModules(
  load: Load | null,
  names: string[],
  timeoutMs = 10_000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let bootloader: Bootloader | undefined;
    try {
      bootloader = load?.("Bootloader") as Bootloader | undefined;
    } catch (_) {}
    if (!load || typeof bootloader?.loadModules !== "function") {
      reject(new Error("Messenger's module loader is unavailable"));
      return;
    }
    const timer = setTimeout(
      () => reject(new Error(`Messenger did not load ${names.join(", ")}`)),
      timeoutMs,
    );
    try {
      bootloader.loadModules(
        names,
        () => {
          clearTimeout(timer);
          try {
            resolve(names.map((name) => load(name)));
          } catch (error) {
            reject(error);
          }
        },
        "carrier",
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
