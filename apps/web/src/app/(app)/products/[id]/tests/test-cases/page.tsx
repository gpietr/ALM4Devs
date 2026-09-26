"use client";

import { use } from "react";
import { ProductEntryPage } from "../../entry-page";

export default function TestCasesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ProductEntryPage productId={id} entry="testCases" />;
}
