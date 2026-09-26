"use client";

import { use } from "react";
import { NodeView } from "../../_node/node-view";

export default function OtsItemPage({ params }: { params: Promise<{ otsId: string }> }) {
  const { otsId } = use(params);
  return <NodeView nodeId={otsId} workspace="ots" />;
}
