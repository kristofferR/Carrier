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
      buttonLabel: "Install Carrier 1.4.0",
      version: "1.4.0",
    });
    expect(calls).toEqual(["update_install_mode", "discovered_update"]);

    const cancelled = await controller.activate(() => false);
    expect(cancelled.status).toBe("Update install cancelled.");
    expect(calls).toEqual(["update_install_mode", "discovered_update"]);

    const installed = await controller.activate(() => true);
    expect(installed.phase).toBe("up-to-date");
    expect(calls).toEqual(["update_install_mode", "discovered_update", "install_update"]);
    expect(states.some((state) => state.phase === "installing")).toBe(true);
  });

  test("manual check still requires consent before install", async () => {
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
    await controller.activate(() => false);
    expect(calls).toEqual(["update_install_mode", "discovered_update", "check_for_updates"]);

    await controller.activate(() => true);
    expect(calls).toEqual([
      "update_install_mode",
      "discovered_update",
      "check_for_updates",
      "install_update",
    ]);
  });

  test("reports up-to-date checks without asking for install consent", async () => {
    const calls: string[] = [];
    let confirmations = 0;
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
    const result = await controller.activate(() => {
      confirmations += 1;
      return true;
    });

    expect(result).toMatchObject({
      phase: "up-to-date",
      status: "Carrier is up to date.",
      busy: false,
    });
    expect(confirmations).toBe(0);
    expect(calls).toEqual(["update_install_mode", "discovered_update", "check_for_updates"]);
  });

  test("routes pacman-owned installs to AUR without attempting a built-in install", async () => {
    const calls: string[] = [];
    const controller = new UpdateConsentController(async (command) => {
      calls.push(command);
      if (command === "update_install_mode") {
        return {
          kind: "manual",
          buttonLabel: "Open Carrier on AUR",
          instructions: "Run paru -S carrier to update.",
        };
      }
      if (command === "discovered_update") return "2.1.0";
      if (command === "open_manual_update") return null;
      throw new Error(`unexpected command: ${command}`);
    });

    expect(await controller.initialize()).toMatchObject({
      phase: "available",
      buttonLabel: "Open Carrier on AUR",
      status: "Carrier 2.1.0 is available. Run paru -S carrier to update.",
    });

    const cancelled = await controller.activate(() => false);
    expect(cancelled.status).toBe("Update page not opened. Run paru -S carrier to update.");
    expect(calls).not.toContain("install_update");

    const opened = await controller.activate(() => true);
    expect(opened).toMatchObject({
      phase: "available",
      buttonLabel: "Open Carrier on AUR",
      status: "Update page opened. Run paru -S carrier to update.",
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
    const checkFailure = await controller.activate(() => true).catch((error: unknown) => error);
    expect(checkFailure).toBeInstanceOf(Error);
    expect(controller.fail(checkFailure)).toMatchObject({
      phase: "idle",
      status: "Update check failed. unexpected update-check result: unexpected",
      busy: false,
    });

    failInstall = true;
    const installFailure = await controller.activate(() => true).catch((error: unknown) => error);
    expect(installFailure).toBeInstanceOf(Error);
    expect(controller.fail(installFailure)).toMatchObject({
      phase: "available",
      buttonLabel: "Install Carrier 3.0.0",
      status: "Update install failed. offline",
      busy: false,
      version: "3.0.0",
    });
  });
});
