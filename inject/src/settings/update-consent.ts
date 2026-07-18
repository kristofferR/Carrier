export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "cancelled"
  | "installing"
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

function availableState(
  version: string,
  status = `Carrier ${version} is available.`,
): UpdateUiState {
  return {
    phase: "available",
    buttonLabel: `Install Carrier ${version}`,
    status,
    busy: false,
    version,
  };
}

/**
 * Consent-preserving update state machine for the trusted Settings window.
 * Discovery may change the label, but only activate() can call install_update,
 * and it does so only after the supplied confirmation callback returns true.
 */
export class UpdateConsentController {
  private version = "";
  private phase: UpdatePhase = "idle";

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
    const discovered = await this.invoke("discovered_update");
    if (typeof discovered === "string" && discovered) {
      this.version = discovered;
      return this.publish(availableState(discovered));
    }
    return this.publish({
      phase: "idle",
      buttonLabel: "Check for updates",
      status: "",
      busy: false,
    });
  }

  async activate(confirmInstall: (message: string) => boolean): Promise<UpdateUiState> {
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

    this.publish(availableState(this.version));
    if (
      !confirmInstall(`Carrier ${this.version} is available. Install it now and restart Carrier?`)
    ) {
      return this.publish(availableState(this.version, "Update install cancelled."));
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
    return this.publish(availableState(this.version));
  }

  fail(): UpdateUiState {
    const installing = this.phase === "installing";
    return this.publish({
      phase: this.version ? "available" : "idle",
      buttonLabel: this.version ? `Install Carrier ${this.version}` : "Check for updates",
      status: installing ? "Update install failed." : "Update check failed.",
      busy: false,
      version: this.version || undefined,
    });
  }
}
