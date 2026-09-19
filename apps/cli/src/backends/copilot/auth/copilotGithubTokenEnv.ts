/**
 * Canonical GitHub token environment keys for the Copilot backend.
 *
 * Contract basis: GitHub Copilot CLI 1.0.86 `copilot help environment` documents
 * "`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in order of precedence): an authentication
 * token that takes precedence over previously stored credentials."
 *
 * This list therefore owns both local auth detection (`copilotCliAuthSpec`) and the
 * connected-service runtime projection (`createCopilotConnectedServicesMaterializer`). Writing only
 * the highest-precedence `COPILOT_GITHUB_TOKEN` key lets a selected connected profile take
 * precedence over an ambient `GH_TOKEN`/`GITHUB_TOKEN` and over Copilot's stored credentials,
 * without rewriting the environment other tooling (`gh`) reads.
 */
export const COPILOT_GITHUB_TOKEN_ENV_KEY = 'COPILOT_GITHUB_TOKEN';

export const COPILOT_GITHUB_TOKEN_ENV_KEYS = [
  COPILOT_GITHUB_TOKEN_ENV_KEY,
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

export type CopilotGithubTokenEnvKey = typeof COPILOT_GITHUB_TOKEN_ENV_KEYS[number];
