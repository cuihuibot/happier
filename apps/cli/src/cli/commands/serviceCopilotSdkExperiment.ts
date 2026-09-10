import { updateSettings, readSettings } from '@/persistence';
import {
  type CopilotSdkExperimentSettings,
  CopilotSdkExperimentSettingsError,
  disableCopilotSdkExperimentOptIn,
  parseCopilotSdkExperimentOptIn,
  readCopilotSdkExperimentSettings,
  toPersistedCopilotSdkExperiment,
} from '@/settings/copilotSdkExperimentSettings';

const SCOPE_NOTICE = 'Scope: host-wide. Every new Copilot session launched by this machine\'s background service inherits the flight; it is not per-user or per-device.';
const APPLY_NOTICE = 'Not active until the service definition is re-applied: run `happier service restart`. Running sessions keep their existing backend identity.';
const RETAINED_PATH_NOTICE = 'The native Copilot CLI path above is retained so sessions already bound to the SDK backend can still be reopened. It does not opt new sessions in.';

function readFlagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index >= 0) {
    const value = argv[index + 1];
    return typeof value === 'string' ? value : '';
  }
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

/**
 * Renders the SAVED setting.
 *
 * This reports persisted state, not what the running service is currently
 * applying, so every branch states that a service re-apply is required.
 * Omitting it from a branch would let an operator who saved a change but has
 * not restarted read the output as already in effect.
 */
function writeStatus(state: CopilotSdkExperimentSettings | null): void {
  if (state?.newSessionOptIn) {
    process.stdout.write(`Saved setting — Copilot SDK experiment: enabled\nNative Copilot CLI path: ${state.cliPath}\n${SCOPE_NOTICE}\n${APPLY_NOTICE}\n`);
    return;
  }
  if (state) {
    process.stdout.write(`Saved setting — Copilot SDK experiment: disabled\nNew sessions use the ACP default.\nRetained native Copilot CLI path: ${state.cliPath}\n${RETAINED_PATH_NOTICE}\n${APPLY_NOTICE}\n`);
    return;
  }
  process.stdout.write(`Saved setting — Copilot SDK experiment: disabled\nNew sessions use the ACP default.\n${SCOPE_NOTICE}\n${APPLY_NOTICE}\n`);
}

/**
 * Operator entry point for the experimental Copilot SDK flight.
 *
 * Persists the opt-in through the atomic settings owner so the daemon service
 * definition is generated from it; rollback to the ACP default for new sessions
 * is `disable` followed by a service re-apply.
 */
export async function handleServiceCopilotSdkExperimentCliCommand(params: Readonly<{
  argv: readonly string[];
  commandPath: string;
}>): Promise<void> {
  // Dispatched as `<invoker> service copilot-sdk-experiment <action>`, so the
  // subcommand name leads the forwarded argv.
  const tokens = params.argv[0] === 'copilot-sdk-experiment' ? params.argv.slice(1) : params.argv;
  const action = tokens[0] ?? 'status';

  if (action === 'enable') {
    const rawCliPath = readFlagValue(tokens, '--cli-path');
    if (rawCliPath === null) {
      throw new CopilotSdkExperimentSettingsError(
        `Missing --cli-path. The Copilot SDK runtime cannot start without the native Copilot CLI path.\nUsage: ${params.commandPath} copilot-sdk-experiment enable --cli-path <path>`,
      );
    }
    const optIn = parseCopilotSdkExperimentOptIn({ cliPath: rawCliPath });
    await updateSettings((current) => ({
      ...current,
      copilotSdkExperiment: toPersistedCopilotSdkExperiment(optIn),
    }));
    writeStatus(optIn);
    return;
  }

  if (action === 'disable') {
    // Clears the new-session opt-in but keeps the validated native path, so
    // sessions already bound to the SDK backend remain reopenable.
    let retained: CopilotSdkExperimentSettings | undefined;
    await updateSettings((current) => {
      retained = disableCopilotSdkExperimentOptIn(current);
      return { ...current, copilotSdkExperiment: toPersistedCopilotSdkExperiment(retained) };
    });
    process.stdout.write(`Copilot SDK experiment: disabled\nNew sessions return to the ACP default.\n${APPLY_NOTICE}\n`);
    if (retained) {
      process.stdout.write(`Retained native Copilot CLI path: ${retained.cliPath}\n${RETAINED_PATH_NOTICE}\n`);
    }
    return;
  }

  if (action === 'status') {
    writeStatus(readCopilotSdkExperimentSettings(await readSettings()));
    return;
  }

  throw new CopilotSdkExperimentSettingsError(
    `Unknown copilot-sdk-experiment action "${action}".\nUsage: ${params.commandPath} copilot-sdk-experiment <status|enable --cli-path <path>|disable>`,
  );
}
