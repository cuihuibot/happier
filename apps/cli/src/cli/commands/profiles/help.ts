import chalk from 'chalk';

export function showProfilesHelp(): void {
  console.log(`
${chalk.bold('happier profiles')} - Backend profiles

${chalk.bold('Usage:')}
  happier profiles list [--refresh-settings] [--json]
  happier profiles set <id-or-name> [--name <name>] [--backend <target>]
    [--config-options <json>] [--model <id>] [--permission-mode <mode>]
    [--run-class bounded|long_lived] [--retention ephemeral|resumable]
    [--io-mode request_response|streaming] [--connected-services <bindings-json>]
    [--delegation-routing native|happier|inherit] [--json]
  happier profiles set --account --delegation-routing native|happier [--json]

${chalk.bold('Aliases:')}
  happier profile list

${chalk.bold('Notes:')}
  - Use --profile <id-or-name> when starting a session to apply a profile.
  - Run "happier auth login" to see custom profiles saved in your account settings.
  - Creating a custom profile requires --name; built-in profiles cannot be overwritten.
  - Native mapping options come from the selected runtime. Saving never installs definitions.
  - Routing changes apply to fresh parents, not existing sessions.
`);
}
