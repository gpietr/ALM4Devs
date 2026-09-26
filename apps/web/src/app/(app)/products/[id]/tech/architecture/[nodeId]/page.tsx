"use client";

import { use } from "react";
import { NodeView } from "../../_node/node-view";

export default function ArchitectureNodePage({ params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = use(params);
  return <NodeView nodeId={nodeId} workspace="architecture" />;
}
