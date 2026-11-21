export { openAuthorWorkspace, type AuthorWorkspace } from "./workspace.ts";
export {
  createZhizhangAgentTools,
  registerZhizhangTools,
  type ZhizhangAgentToolDefinition,
} from "./tools.ts";
export {
  HOST_REQUIRED_SERVICES,
  HOST_SERVICE_CONTRACTS,
  describeError,
  getHostService,
  registerHostRoute,
  runInServiceScope,
  type DsHPluginContext,
  type HostServiceContract,
  type HostToolRegistrar,
} from "./dsh-adapter.ts";
export {
  DEFAULT_TOOL_TIMEOUT_MS,
  assertHostToolDefinition,
  defineParameters,
  openOutputSchema,
  registerHostTools,
  serializeToolResult,
  toHostToolDefinition,
  type AgentToolSpec,
  type HostToolDefinition,
} from "./dsh-tools-adapter.ts";
export {
  buildSanitizedDiagnostics,
  createZhizhangConfigSchema,
  registerZhizhangSettings,
  type SanitizedDiagnosticsReport,
  type ZhizhangConfigSchema,
} from "./settings.ts";
export {
  createHostJobEngine,
  type ActiveJobCounts,
  type HostJobEngine,
} from "./job-engine.ts";
