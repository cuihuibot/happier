import { updateSettings, readSettings } from '@/persistence';
import {
  CopilotSdkExperimentSettingsError,
  parseCopilotSdkExperimentOptIn,
  readCopilotSdkExperimentSettings,
} from '@/settings/copilotSdkExperimentSettings';

const SCOPE_NOTICE = 'Scope: host-wide. Every new Copilot session launched by this machine\'s background service inherits the flight; it is not per-user or per-device.';
const APPLY_NOTICE = 'Not active until the service definition is re-applied: run `happier service restart`. Running sessions keep their existing backend identity.';

function readFlagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index >= 0) {
    const value = argv[index + 1];
    return typeof value === 'string' ? value : '';
  }
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function writeStatus(cliPath: string | null): void {
  if (cliPath) {
    process.stdout.write(`Copilot SDK experiment: enabled\nNative Copilot CLI path: ${cliPath}\n${SCOPE_NOTICE}\n${APPLY_NOTICE}\n`);
    return;
  }
  process.stdout.write(`Copilot SDK experiment: disabled\nNew sessions use the ACP default.\n${SCOPE_NOTICE}\n`);
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
    await updateSettings((current) => ({ ...current, copilotSdkExperiment: optIn }));
    writeStatus(optIn.cliPath);
    return;
  }

  if (action === 'disable') {
    await updateSettings((current) => ({ ...current, copilotSdkExperiment: undefined }));
    process.stdout.write(`Copilot SDK experiment: disabled\nNew sessions return to the ACP default.\n${APPLY_NOTICE}\n`);
    return;
  }

  if (action === 'status') {
    const current = readCopilotSdkExperimentSettings(await readSettings());
    writeStatus(current?.cliPath ?? null);
    return;
  }

  throw new CopilotSdkExperimentSettingsError(
    `Unknown copilot-sdk-experiment action "${action}".\nUsage: ${params.commandPath} copilot-sdk-experiment <status|enable --cli-path <path>|disable>`,
  );
}
