# Container image for the self-heal fix agent.
#
# Pulls the computerd binary out of the public GHCR image (a single layer over
# scratch containing only the SEA binary at /usr/local/bin/computerd) and copies
# it into a slim Debian runtime that also carries node + git + ripgrep + the pi
# coding agent. computerd mounts a FUSE filesystem at MOUNT_POINT (/workspace)
# so exec'd commands see the same VFS the RPC surface reads and writes; with
# FUSE_MOUNT=auto the same image falls back to the userspace shim under
# `wrangler dev`.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git ripgrep \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# The pi coding agent (headless `pi -p` runs the fix loop) + pnpm for installs.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent pnpm

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
