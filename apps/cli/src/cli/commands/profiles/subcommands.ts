import { runProfilesListCommand } from './list';
import { runProfilesSetCommand } from './set';

export async function runProfilesSubcommand(subcommand: string, args: string[]): Promise<boolean> {
  if (subcommand === 'set') {
    await runProfilesSetCommand(args.slice(1));
    return true;
  }
  if (subcommand === 'list') {
    await runProfilesListCommand(args.slice(1));
    return true;
  }
  return false;
}
