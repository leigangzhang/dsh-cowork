/**
 * @dsh-external/dsh-cowork host plugin entry point.
 *
 * The package entry is a re-export barrel only. The assembly lives in
 * `src/app/apply.ts`, the validated configuration surface in
 * `src/app/config.ts`, and the probe helper in `src/dev/panel-probe.ts`.
 * Every other module imports its dependency by direct path, so no directory
 * adds a second barrel and the 50 KiB read limit stays visible.
 */
export {
  apply,
  createOpenWorkspacePathPort,
  inject,
  OPEN_WORKSPACE_PATH_TIMEOUT_MS,
  panelRoutePathname,
} from './app/apply.js'
export type { HostSessionOpener } from './app/apply.js'
export { CONFIG_DEFAULTS, Config, normalizeConfig } from './app/config.js'
export type { IsolationConfig, ReviewerConfig, RoutingConfig } from './app/config.js'
