/**
 * Barrel module re-exporting the per-surface OpenAPI plumbing.
 *
 * This file used to hold the full definitions for all three surfaces
 * (~570 lines). With all three surfaces shipped, the contents split
 * into per-surface files under `./components/`:
 *
 *   - `./components/shared.ts` — `ResponseConfig` type alias and the
 *     `guardDuplicateComponentRegistration` runtime guard
 *   - `./components/dashboard.ts` — dashboard envelope, names, refs,
 *     `sharedDashboardResponse`, `dashboardOpenApiHonoOptions`,
 *     `registerDashboardResponseComponents`
 *   - `./components/control.ts` — control surface counterparts plus
 *     `controlProblemDetailsSchema`
 *   - `./components/agent.ts` — agent surface counterparts
 *
 * The barrel preserves the existing import path
 * (`'../../openapi/components.js'`) so the ~30 route files don't need
 * to be touched. New code can import from either the barrel or
 * directly from the per-surface files — direct imports are slightly
 * more discoverable, but the barrel stays the documented public
 * entrypoint.
 */

export {
  _guardDuplicateComponentRegistrationForTest,
  guardDuplicateComponentRegistration,
  type ResponseConfig,
} from './components/shared.js'

export {
  DASHBOARD_RESPONSE_REFS,
  type DashboardResponseRef,
  dashboardOpenApiHonoOptions,
  registerDashboardResponseComponents,
  sharedDashboardResponse,
} from './components/dashboard.js'

export {
  CONTROL_RESPONSE_REFS,
  type ControlResponseRef,
  controlOpenApiHonoOptions,
  controlProblemDetailsSchema,
  registerControlResponseComponents,
  sharedControlResponse,
} from './components/control.js'

export {
  AGENT_RESPONSE_REFS,
  type AgentResponseRef,
  agentOpenApiHonoOptions,
  registerAgentResponseComponents,
  sharedAgentResponse,
} from './components/agent.js'
