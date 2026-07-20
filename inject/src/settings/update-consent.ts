export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "cancelled"
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

type UpdateInvoke = (command: string) => Promise<unknown>;
type StateListener = (state: UpdateUiState) => void;

type UpdateInstallMode =
  | { kind: "built-in" }
  | { kind: "manual"; buttonLabel: string; instructions: string };

function parseInstallMode(value: unknown): UpdateInstallMode {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error("missing update install mode");
  }
  if (value.kind === "built-in") return { kind: "built-in" };
  if (
    value.kind === "manual" &&
    "buttonLabel" in value &&
    typeof value.buttonLabel === "string" &&
    value.buttonLabel &&
    "instructions" in value &&
    typeof value.instructions === "string" &&
    value.instructions
  ) {
    return {
      kind: "manual",
      buttonLabel: value.buttonLabel,
      instructions: value.instructions,
    };
  }
  throw new Error("invalid update install mode");
}

function availableState(
  version: string,
  installMode: UpdateInstallMode,
  status = `Carrier ${version} is available.`,
): UpdateUiState {
  const manual = installMode.kind === "manual";
  return {
    phase: "available",
    buttonLabel: manual ? installMode.buttonLabel : `Install Carrier ${version}`,
    status: manual ? `${status} ${installMode.instructions}` : status,
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
 * Discovery may change the label, but only activate() can call install_update,
 * and it does so only after the supplied confirmation callback returns true.
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
    if (typeof discovered === "string" && discovered) {
      this.version = discovered;
      return this.publish(availableState(discovered, this.installMode));
    }
    return this.publish({
      phase: "idle",
      buttonLabel: "Check for updates",
      status: "",
      busy: false,
    });
  }

  async activate(confirmInstall: (message: string) => boolean): Promise<UpdateUiState> {
    if (!this.installMode) throw new Error("update controller was not initialized");
    if (!this.version) {
      this.publish({
        phase: "checking",
        buttonLabel: "Check for updates",
        status: "Checking for updates…",
        busy: true,
      });
      const result = String(await this.invoke("check_for_updates"));
      if (result === "up-to-date") {
        return this.publish({
          phase: "up-to-date",
          buttonLabel: "Check for updates",
          status: "Carrier is up to date.",
          busy: false,
        });
      }
      this.version = result.startsWith("available:") ? result.slice(10) : "";
      if (!this.version) throw new Error(`unexpected update-check result: ${result}`);
    }

    this.publish(availableState(this.version, this.installMode));
    if (this.installMode.kind === "manual") {
      if (
        !confirmInstall(
          `Carrier ${this.version} is available. Open the package page for update instructions?`,
        )
      ) {
        return this.publish(
          availableState(this.version, this.installMode, "Update page not opened."),
        );
      }
      this.publish({
        phase: "opening-manual",
        buttonLabel: this.installMode.buttonLabel,
        status: "Opening package-manager update instructions…",
        busy: true,
        version: this.version,
      });
      await this.invoke("open_manual_update");
      return this.publish(availableState(this.version, this.installMode, "Update page opened."));
    }

    if (
      !confirmInstall(`Carrier ${this.version} is available. Install it now and restart Carrier?`)
    ) {
      return this.publish(
        availableState(this.version, this.installMode, "Update install cancelled."),
      );
    }

    this.publish({
      phase: "installing",
      buttonLabel: `Install Carrier ${this.version}`,
      status: "Downloading and installing update…",
      busy: true,
      version: this.version,
    });
    const installResult = String(await this.invoke("install_update"));
    if (installResult === "up-to-date") {
      this.version = "";
      return this.publish({
        phase: "up-to-date",
        buttonLabel: "Check for updates",
        status: "Carrier is already up to date.",
        busy: false,
      });
    }
    return this.publish(availableState(this.version, this.installMode));
  }

  fail(error?: unknown): UpdateUiState {
    const action =
      this.phase === "installing"
        ? "Update install failed."
        : this.phase === "opening-manual"
          ? "Could not open the update page."
          : "Update check failed.";
    const detail = failureDetail(error);
    return this.publish({
      phase: this.version ? "available" : "idle",
      buttonLabel:
        this.version && this.installMode?.kind === "manual"
          ? this.installMode.buttonLabel
          : this.version
            ? `Install Carrier ${this.version}`
            : "Check for updates",
      status: detail ? `${action} ${detail}` : action,
      busy: false,
      version: this.version || undefined,
    });
  }
}
