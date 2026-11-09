import { describe, expect, test } from "bun:test";
import { UpdateConsentController, type UpdateUiState } from "./update-consent";

describe("UpdateConsentController", () => {
  test("discovery changes the action without installing", async () => {
    const calls: string[] = [];
    const states: UpdateUiState[] = [];
    const controller = new UpdateConsentController(
      async (command) => {
        calls.push(command);
        if (command === "update_install_mode") return { kind: "built-in" };
        if (command === "discovered_update") return "1.4.0";
        if (command === "install_update") return "up-to-date";
        throw new Error(`unexpected command: ${command}`);
      },
      (state) => states.push(state),
    );

    const discovered = await controller.initialize();
    expect(discovered).toMatchObject({
      phase: "available",
      buttonLabel: "Install Chatpane 1.4.0",
      version: "1.4.0",
    });
    expect(calls).toEqual(["update_install_mode", "discovered_update"]);

    const installed = await controller.activate();
    expect(installed.phase).toBe("up-to-date");
    expect(calls).toEqual(["update_install_mode", "discovered_update", "install_update"]);
    expect(states.some((state) => state.phase === "installing")).toBe(true);
  });

  test("refresh follows a replaced or cleared offer without ever installing", async () => {
    let discovered: string | null = "1.4.0";
    const calls: string[] = [];
    const controller = new UpdateConsentController(async (command) => {
      calls.push(command);
      if (command === "update_install_mode") return { kind: "built-in" };
      if (command === "discovered_update") return discovered;
      if (command === "check_for_updates") return "up-to-date";
      throw new Error(`unexpected command: ${command}`);
    });
    await controller.initialize();

    discovered = "1.5.0";
    expect((await controller.refresh())?.buttonLabel).toBe("Install Chatpane 1.5.0");
    expect(await controller.refresh()).toBeNull();

    discovered = null;
    expect((await controller.refresh())?.buttonLabel).toBe("Check for updates");
    // The cleared offer must not survive: the action checks, it does not install.
    await controller.activate();
    expect(calls).not.toContain("install_update");
    expect(calls).toContain("check_for_updates");
  });

  test("refresh never interrupts an install that starts while it reads", async () => {
    let finishInstall: (value: string) => void = () => {};
    let readDiscovery: (value: string) => void = () => {};
    let reads = 0;
    const states: UpdateUiState[] = [];
    const controller = new UpdateConsentController(
      (command) => {
        if (command === "update_install_mode") return Promise.resolve({ kind: "built-in" });
        if (command === "discovered_update") {
          reads++;
          if (reads === 1) return Promise.resolve("1.4.0");
          return new Promise((resolve) => {
            readDiscovery = resolve;
          });
        }
        if (command === "install_update") {
          return new Promise((resolve) => {
            finishInstall = resolve;
          });
        }
        return Promise.reject(new Error(`unexpected command: ${command}`));
      },
      (state) => states.push(state),
    );
    await controller.initialize();
    const refreshing = controller.refresh();
    const installing = controller.activate();
    readDiscovery("1.5.0");
    expect(await refreshing).toBeNull();
    expect(states.at(-1)?.phase).toBe("installing");
    finishInstall("up-to-date");
    await installing;
  });

  test("manual check reveals a separate install action", async () => {
    const calls: string[] = [];
    const controller = new UpdateConsentController(async (command) => {
      calls.push(command);
      if (command === "update_install_mode") return { kind: "built-in" };
      if (command === "discovered_update") return null;
      if (command === "check_for_updates") return "available:2.0.0";
      if (command === "install_update") return "up-to-date";
      throw new Error(`unexpected command: ${command}`);
    });

    await controller.initialize();
    expect(await controller.activate()).toMatchObject({
      phase: "available",
      buttonLabel: "Install Chatpane 2.0.0",
      version: "2.0.0",
    });
    expect(calls).toEqual(["update_install_mode", "discovered_update", "check_for_updates"]);

    await controller.activate();
    expect(calls).toEqual([
      "update_install_mode",
      "discovered_update",
      "check_for_updates",
      "install_update",
    ]);
  });

  test("reports up-to-date checks without exposing an install action", async () => {
    const calls: string[] = [];
    const controller = new UpdateConsentController(async (command) => {
      calls.push(command);
      if (command === "update_install_mode") return { kind: "built-in" };
      if (command === "discovered_update") return null;
      if (command === "check_for_updates") return "up-to-date";
      throw new Error(`unexpected command: ${command}`);
    });

    expect(await controller.initialize()).toMatchObject({
      phase: "idle",
      busy: false,
    });
    const result = await controller.activate();

    expect(result).toMatchObject({
      phase: "up-to-date",
      status: "Chatpane is up to date.",
      busy: false,
    });
    expect(calls).toEqual(["update_install_mode", "discovered_update", "check_for_updates"]);
  });

  test("routes pacman-owned installs to AUR without attempting a built-in install", async () => {
    const calls: string[] = [];
    const controller = new UpdateConsentController(async (command) => {
      calls.push(command);
      if (command === "update_install_mode") {
        return {
          kind: "manual",
          buttonLabel: "Open Chatpane on AUR",
          instructions: "Run paru -S chatpane to update.",
        };
      }
      if (command === "discovered_update") return "2.1.0";
      if (command === "open_manual_update") return null;
      throw new Error(`unexpected command: ${command}`);
    });

    expect(await controller.initialize()).toMatchObject({
      phase: "available",
      buttonLabel: "Open Chatpane on AUR",
      status: "Chatpane 2.1.0 is available. Run paru -S chatpane to update.",
    });

    const opened = await controller.activate();
    expect(opened).toMatchObject({
      phase: "available",
      buttonLabel: "Open Chatpane on AUR",
      status: "Update page opened. Run paru -S chatpane to update.",
    });
    expect(calls).toEqual(["update_install_mode", "discovered_update", "open_manual_update"]);
    expect(calls).not.toContain("install_update");
  });

  test("recovers the action after check and install failures", async () => {
    let failInstall = false;
    const controller = new UpdateConsentController(async (command) => {
      if (command === "update_install_mode") return { kind: "built-in" };
      if (command === "discovered_update") return null;
      if (command === "check_for_updates") {
        if (!failInstall) return "unexpected";
        return "available:3.0.0";
      }
      if (command === "install_update") throw new Error("offline");
      throw new Error(`unexpected command: ${command}`);
    });

    await controller.initialize();
    const checkFailure = await controller.activate().catch((error: unknown) => error);
    expect(checkFailure).toBeInstanceOf(Error);
    expect(controller.fail(checkFailure)).toMatchObject({
      phase: "idle",
      status: "Update check failed. unexpected update-check result: unexpected",
      busy: false,
    });

    failInstall = true;
    expect(await controller.activate()).toMatchObject({
      phase: "available",
      buttonLabel: "Install Chatpane 3.0.0",
      version: "3.0.0",
    });
    const installFailure = await controller.activate().catch((error: unknown) => error);
    expect(installFailure).toBeInstanceOf(Error);
    expect(controller.fail(installFailure)).toMatchObject({
      phase: "available",
      buttonLabel: "Install Chatpane 3.0.0",
      status: "Update install failed. offline",
      busy: false,
      version: "3.0.0",
    });
  });
});

test("debug installs never query or install public releases", async () => {
  const calls: string[] = [];
  const controller = new UpdateConsentController(async (command) => {
    calls.push(command);
    if (command === "update_install_mode")
      return {
        kind: "debug",
        buttonLabel: "Debug build instructions",
        instructions: "Follows main",
      };
    if (command === "discovered_update") return "9.0.0";
    if (command === "open_manual_update") return;
    throw new Error(`Release updater reached: ${command}`);
  });
  expect((await controller.initialize()).status).toBe("Follows main");
  await controller.activate();
  expect(calls).toEqual(["update_install_mode", "discovered_update", "open_manual_update"]);
});
