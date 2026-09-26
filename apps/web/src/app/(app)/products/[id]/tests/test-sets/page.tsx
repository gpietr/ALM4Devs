"use client";

import { use } from "react";
import { ProductEntryPage } from "../../entry-page";

export default function TestSetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ProductEntryPage productId={id} entry="testSets" />;
}
