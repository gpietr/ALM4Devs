"use client";

import { TopBar } from "@/components/context-strip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useState } from "react";

export default function ProductsPage() {
  const utils = trpc.useUtils();
  const products = trpc.products.list.useQuery();
  const createProduct = trpc.products.create.useMutation({
    onSuccess: () => utils.products.list.invalidate(),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-5 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="font-heading text-[28px] leading-tight tracking-tight">Products</h1>
        <Link href="/" className="text-[13px] text-muted-foreground hover:text-foreground">
          Back home
        </Link>
      </div>

      <Card className="mb-10 p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createProduct.mutate(
              { name, description: description || undefined },
              { onSuccess: () => { setName(""); setDescription(""); } },
            );
          }}
          className="space-y-3"
        >
          <h2 className="text-sm font-medium text-foreground">New product</h2>
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GlucoSense Mobile App" />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
          />
          {createProduct.error && <p className="text-sm text-destructive">{createProduct.error.message}</p>}
          <Button type="submit" disabled={createProduct.isPending}>
            {createProduct.isPending ? "Creating..." : "Create product"}
          </Button>
        </form>
      </Card>

      {products.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {products.error && <p className="text-sm text-destructive">{products.error.message}</p>}

      <ul className="divide-y divide-border overflow-hidden rounded-md border">
        {products.data?.map((product) => (
          <li key={product.id}>
            <Link href={`/products/${product.id}`} className="block px-4 py-3 transition-colors hover:bg-muted/50">
              <p className="font-medium">{product.name}</p>
              {product.description && <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>}
            </Link>
          </li>
        ))}
      </ul>
      {products.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">No products yet - create one above.</p>
      )}
      </main>
    </>
  );
}
