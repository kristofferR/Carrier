import { settingsText } from "../i18n";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "installing"
  | "opening-manual"
  | "up-to-date";

export interface UpdateUiState {
  phase: UpdatePhase;
  buttonLabel: string;
  status: string;
  busy: boolean;
  version?: string;
}

type UpdateInvoke = (
  command:
    | "update_install_mode"
    | "discovered_update"
    | "open_manual_update"
    | "check_for_updates"
    | "install_update",
) => Promise<unknown>;
type StateListener = (state: UpdateUiState) => void;

type UpdateInstallMode =
  | { kind: "built-in" }
  | { kind: "debug"; buttonLabel: string; instructions: string }
  | { kind: "manual"; buttonLabel: string; instructions: string };

function parseInstallMode(value: unknown): UpdateInstallMode {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error("missing update install mode");
  }
  if (value.kind === "built-in") return { kind: "built-in" };
  if (
    (value.kind === "manual" || value.kind === "debug") &&
    "buttonLabel" in value &&
    typeof value.buttonLabel === "string" &&
    value.buttonLabel &&
    "instructions" in value &&
    typeof value.instructions === "string" &&
    value.instructions
  ) {
    return {
      kind: value.kind,
      buttonLabel: value.buttonLabel,
      instructions: value.instructions,
    };
  }
  throw new Error("invalid update install mode");
}

const checkLabel = () => settingsText("settings.update.check");
const installLabel = (version: string) => settingsText("settings.update.install", { version });

/** An offered update; `opened` once its package-manager page was opened. */
function availableState(
  version: string,
  installMode: UpdateInstallMode,
  opened = false,
): UpdateUiState {
  if (installMode.kind !== "manual") {
    return {
      phase: "available",
      buttonLabel: installLabel(version),
      status: settingsText("settings.update.available", { version }),
      busy: false,
      version,
    };
  }
  const { buttonLabel, instructions } = installMode;
  return {
    phase: "available",
    buttonLabel,
    status: opened
      ? settingsText("settings.update.page_opened_with_instructions", { instructions })
      : settingsText("settings.update.available_with_instructions", { version, instructions }),
    busy: false,
    version,
  };
}

function failureDetail(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Consent-preserving update state machine for the trusted Settings window.
 * A check can only reveal the explicitly labelled install/open action. A later
 * activation of that action is the user's consent to mutate the installation.
 */
export class UpdateConsentController {
  private version = "";
  private phase: UpdatePhase = "idle";
  private installMode: UpdateInstallMode | null = null;

  constructor(
    private readonly invoke: UpdateInvoke,
    private readonly onState: StateListener = () => {},
  ) {}

  private publish(state: UpdateUiState): UpdateUiState {
    this.phase = state.phase;
    this.onState(state);
    return state;
  }

  async initialize(): Promise<UpdateUiState> {
    const [rawInstallMode, discovered] = await Promise.all([
      this.invoke("update_install_mode"),
      this.invoke("discovered_update"),
    ]);
    this.installMode = parseInstallMode(rawInstallMode);
    if (this.installMode.kind === "debug") {
      return this.publish({
        phase: "idle",
        buttonLabel: this.installMode.buttonLabel,
        status: this.installMode.instructions,
        busy: false,
      });
    }
    if (typeof discovered === "string" && discovered) {
      this.version = discovered;
      return this.publish(availableState(discovered, this.installMode));
    }
    // No retained offer: the action must check again, never install.
    this.version = "";
    return this.publish({
      phase: "idle",
      buttonLabel: checkLabel(),
      status: "",
      busy: false,
    });
  }

  private operationActive(): boolean {
    return (
      this.phase === "checking" || this.phase === "installing" || this.phase === "opening-manual"
    );
  }

  /**
   * Re-read the retained discovery (Settings regaining focus): show a newer
   * offer, or go back to "Check for updates" when it was cleared. Never
   * interrupts a check or install, including one that starts during the read.
   * Returns null when nothing changed.
   */
  async refresh(): Promise<UpdateUiState | null> {
    if (!this.installMode || this.installMode.kind === "debug" || this.operationActive()) {
      return null;
    }
    const discovered = await this.invoke("discovered_update");
    if (this.operationActive()) return null;
    const version = typeof discovered === "string" ? discovered : "";
    if (version === this.version) return null;
    this.version = version;
    if (version) return this.publish(availableState(version, this.installMode));
    return this.publish({
      phase: "idle",
      buttonLabel: checkLabel(),
      status: "",
      busy: false,
    });
  }

  async activate(): Promise<UpdateUiState> {
    if (!this.installMode) throw new Error("update controller was not initialized");
    if (this.installMode.kind === "debug") {
      await this.invoke("open_manual_update");
      return this.publish({
        phase: "idle",
        buttonLabel: this.installMode.buttonLabel,
        status: this.installMode.instructions,
        busy: false,
      });
    }
    if (!this.version) {
      this.publish({
        phase: "checking",
        buttonLabel: checkLabel(),
        status: settingsText("settings.update.checking"),
        busy: true,
      });
      const result = String(await this.invoke("check_for_updates"));
      if (result === "up-to-date") {
        return this.publish({
          phase: "up-to-date",
          buttonLabel: checkLabel(),
          status: settingsText("settings.update.up_to_date"),
          busy: false,
        });
      }
      this.version = result.startsWith("available:") ? result.slice(10) : "";
      if (!this.version) throw new Error(`unexpected update-check result: ${result}`);
      // The user clicked "Check for updates", not an install action. Surface a
      // second, explicit action instead of installing in the same activation.
      return this.publish(availableState(this.version, this.installMode));
    }

    this.publish(availableState(this.version, this.installMode));
    if (this.installMode.kind === "manual") {
      this.publish({
        phase: "opening-manual",
        buttonLabel: this.installMode.buttonLabel,
        status: settingsText("settings.update.opening_manual"),
        busy: true,
        version: this.version,
      });
      await this.invoke("open_manual_update");
      return this.publish(availableState(this.version, this.installMode, true));
    }

    this.publish({
      phase: "installing",
      buttonLabel: installLabel(this.version),
      status: settingsText("settings.update.installing"),
      busy: true,
      version: this.version,
    });
    const installResult = String(await this.invoke("install_update"));
    if (installResult === "up-to-date") {
      this.version = "";
      return this.publish({
        phase: "up-to-date",
        buttonLabel: checkLabel(),
        status: settingsText("settings.update.already_up_to_date"),
        busy: false,
      });
    }
    return this.publish(availableState(this.version, this.installMode));
  }

  fail(error?: unknown): UpdateUiState {
    const detail = failureDetail(error);
    let status: string;
    if (this.phase === "installing") {
      status = detail
        ? settingsText("settings.update.install_failed_detail", { detail })
        : settingsText("settings.update.install_failed");
    } else if (this.phase === "opening-manual") {
      status = detail
        ? settingsText("settings.update.open_failed_detail", { detail })
        : settingsText("settings.update.open_failed");
    } else {
      status = detail
        ? settingsText("settings.update.check_failed_detail", { detail })
        : settingsText("settings.update.check_failed");
    }
    return this.publish({
      phase: this.version ? "available" : "idle",
      buttonLabel:
        this.version && this.installMode?.kind === "manual"
          ? this.installMode.buttonLabel
          : this.version
            ? installLabel(this.version)
            : checkLabel(),
      status,
      busy: false,
      version: this.version || undefined,
    });
  }
}
