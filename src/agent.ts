/**
 * FixAgent — a Worker + container-enabled Durable Object that runs a
 * `@cloudflare/computer` Workspace inside a Cloudflare Container. This is the
 * same pattern as the official `examples/container` in cloudflare/computer:
 * a thin DO host over `CloudflareContainerBackend` that boots the container,
 * wires the computerd capnweb session, and exposes `runtime.exec`.
 *
 * The Workflow drives it through `getWorkspace(stub)`.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  type DurableObjectStorageLike,
  type WorkspaceOptions,
  WorkspaceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";

// Re-export so the runtime can build the loopback binding the container
// egress uses to reach this DO (ctx.exports.WorkspaceProxy).
export { WorkspaceProxy };

// The container half of the DO. The backend lives here rather than on FixAgent
// because withWorkspace's options callback needs it while constructing the
// Workspace: base-class fields are initialized by the time the callback runs,
// subclass fields are not.
class FixAgentBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({
    id: "container",
    container: () => this,
    workspace: { binding: "FIX_AGENT", id: this.ctx.id.toString() },
    // Direct egress: pi reaches api.cloudflare.com (Workers AI) and git reaches
    // github.com. Credentials are passed per-exec and never persisted.
    egress: { mode: "direct" },
  });
}

function workspaceOptions(self: InstanceType<typeof FixAgentBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
  };
}

export class FixAgent extends withWorkspace(FixAgentBase, workspaceOptions) {
  override async fetch(request: Request): Promise<Response> {
    return this.backend.handleFetch(request);
  }
}
