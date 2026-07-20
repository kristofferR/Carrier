/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/settings/update-consent.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
var CarrierSettingsUpdate = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // inject/src/settings/update-consent.ts
  var update_consent_exports = {};
  __export(update_consent_exports, {
    UpdateConsentController: () => UpdateConsentController
  });
  function parseInstallMode(value) {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      throw new Error("missing update install mode");
    }
    if (value.kind === "built-in") return { kind: "built-in" };
    if (value.kind === "manual" && "buttonLabel" in value && typeof value.buttonLabel === "string" && value.buttonLabel && "instructions" in value && typeof value.instructions === "string" && value.instructions) {
      return {
        kind: "manual",
        buttonLabel: value.buttonLabel,
        instructions: value.instructions
      };
    }
    throw new Error("invalid update install mode");
  }
  function availableState(version, installMode, status = `Carrier ${version} is available.`) {
    const manual = installMode.kind === "manual";
    return {
      phase: "available",
      buttonLabel: manual ? installMode.buttonLabel : `Install Carrier ${version}`,
      status: manual ? `${status} ${installMode.instructions}` : status,
      busy: false,
      version
    };
  }
  function failureDetail(error) {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
    return raw.replace(/\s+/g, " ").trim().slice(0, 240);
  }
  var UpdateConsentController = class {
    constructor(invoke, onState = () => {
    }) {
      __publicField(this, "invoke", invoke);
      __publicField(this, "onState", onState);
      __publicField(this, "version", "");
      __publicField(this, "phase", "idle");
      __publicField(this, "installMode", null);
    }
    publish(state) {
      this.phase = state.phase;
      this.onState(state);
      return state;
    }
    async initialize() {
      const [rawInstallMode, discovered] = await Promise.all([
        this.invoke("update_install_mode"),
        this.invoke("discovered_update")
      ]);
      this.installMode = parseInstallMode(rawInstallMode);
      if (typeof discovered === "string" && discovered) {
        this.version = discovered;
        return this.publish(availableState(discovered, this.installMode));
      }
      return this.publish({
        phase: "idle",
        buttonLabel: "Check for updates",
        status: "",
        busy: false
      });
    }
    async activate(confirmInstall) {
      if (!this.installMode) throw new Error("update controller was not initialized");
      if (!this.version) {
        this.publish({
          phase: "checking",
          buttonLabel: "Check for updates",
          status: "Checking for updates…",
          busy: true
        });
        const result = String(await this.invoke("check_for_updates"));
        if (result === "up-to-date") {
          return this.publish({
            phase: "up-to-date",
            buttonLabel: "Check for updates",
            status: "Carrier is up to date.",
            busy: false
          });
        }
        this.version = result.startsWith("available:") ? result.slice(10) : "";
        if (!this.version) throw new Error(`unexpected update-check result: ${result}`);
      }
      this.publish(availableState(this.version, this.installMode));
      if (this.installMode.kind === "manual") {
        if (!confirmInstall(
          `Carrier ${this.version} is available. Open the package page for update instructions?`
        )) {
          return this.publish(
            availableState(this.version, this.installMode, "Update page not opened.")
          );
        }
        this.publish({
          phase: "opening-manual",
          buttonLabel: this.installMode.buttonLabel,
          status: "Opening package-manager update instructions…",
          busy: true,
          version: this.version
        });
        await this.invoke("open_manual_update");
        return this.publish(availableState(this.version, this.installMode, "Update page opened."));
      }
      if (!confirmInstall(`Carrier ${this.version} is available. Install it now and restart Carrier?`)) {
        return this.publish(
          availableState(this.version, this.installMode, "Update install cancelled.")
        );
      }
      this.publish({
        phase: "installing",
        buttonLabel: `Install Carrier ${this.version}`,
        status: "Downloading and installing update…",
        busy: true,
        version: this.version
      });
      const installResult = String(await this.invoke("install_update"));
      if (installResult === "up-to-date") {
        this.version = "";
        return this.publish({
          phase: "up-to-date",
          buttonLabel: "Check for updates",
          status: "Carrier is already up to date.",
          busy: false
        });
      }
      return this.publish(availableState(this.version, this.installMode));
    }
    fail(error) {
      const action = this.phase === "installing" ? "Update install failed." : this.phase === "opening-manual" ? "Could not open the update page." : "Update check failed.";
      const detail = failureDetail(error);
      return this.publish({
        phase: this.version ? "available" : "idle",
        buttonLabel: this.version && this.installMode?.kind === "manual" ? this.installMode.buttonLabel : this.version ? `Install Carrier ${this.version}` : "Check for updates",
        status: detail ? `${action} ${detail}` : action,
        busy: false,
        version: this.version || void 0
      });
    }
  };
  return __toCommonJS(update_consent_exports);
})();
