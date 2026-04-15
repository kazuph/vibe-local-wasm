export const WORKSPACE_LAYERS = [
  {
    id: "actor-db",
    owner: "control-plane",
    description: "Owns session, approval, audit, and routing state.",
    currentLocation: "tools/agentos-dev/.agentos-dev/rivetkit/",
  },
  {
    id: "workspace-state",
    owner: "workspace-surface",
    description: "Capability-mediated file reads, writes, snapshots, and change tracking.",
    currentLocation: "tools/agentos-dev/.agentos-dev/workspace/",
  },
  {
    id: "agentfs",
    owner: "integration-path",
    description: "Defined but not actively wired into the current runtime.",
    currentLocation: "tools/agentos-dev/.agentos-dev/agentfs/workspace.db",
  },
] as const;

export const WORKSPACE_EXPORT_IMPORT_CONTRACT = [
  "exportWorkspaceSnapshot",
  "importWorkspaceSnapshot",
  "syncWorkspaceToHost",
  "syncHostIntoWorkspace",
] as const;

export function describeWorkspaceContract() {
  return {
    status: "design" as const,
    layers: WORKSPACE_LAYERS.map((layer) => ({
      id: layer.id,
      owner: layer.owner,
      description: layer.description,
      currentLocation: layer.currentLocation,
    })),
    futureApis: [...WORKSPACE_EXPORT_IMPORT_CONTRACT],
  };
}