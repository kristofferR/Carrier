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
  function availableState(version, status = `Carrier ${version} is available.`) {
    return {
      phase: "available",
      buttonLabel: `Install Carrier ${version}`,
      status,
      busy: false,
      version
    };
  }
  var UpdateConsentController = class {
    constructor(invoke, onState = () => {
    }) {
      __publicField(this, "invoke", invoke);
      __publicField(this, "onState", onState);
      __publicField(this, "version", "");
      __publicField(this, "phase", "idle");
    }
    publish(state) {
      this.phase = state.phase;
      this.onState(state);
      return state;
    }
    async initialize() {
      const discovered = await this.invoke("discovered_update");
      if (typeof discovered === "string" && discovered) {
        this.version = discovered;
        return this.publish(availableState(discovered));
      }
      return this.publish({
        phase: "idle",
        buttonLabel: "Check for updates",
        status: "",
        busy: false
      });
    }
    async activate(confirmInstall) {
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
      this.publish(availableState(this.version));
      if (!confirmInstall(`Carrier ${this.version} is available. Install it now and restart Carrier?`)) {
        return this.publish(availableState(this.version, "Update install cancelled."));
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
      return this.publish(availableState(this.version));
    }
    fail() {
      const installing = this.phase === "installing";
      return this.publish({
        phase: this.version ? "available" : "idle",
        buttonLabel: this.version ? `Install Carrier ${this.version}` : "Check for updates",
        status: installing ? "Update install failed." : "Update check failed.",
        busy: false,
        version: this.version || void 0
      });
    }
  };
  return __toCommonJS(update_consent_exports);
})();
