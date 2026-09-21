"use client";

import { Frame } from "@/components/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/**
 * A product's named, reusable subsets of tests to run (authoring only - actually running
 * a whole set isn't wired up yet, see the plan). Same simple create-form-plus-table shape
 * as versions-section.tsx; each row links to the set's own detail page
 * (test-sets/[id]/page.tsx), which owns the ordered item list, environments, and custom
 * parameters.
 */
export function TestSetsSection({ productId }: { productId: string }) {
  const products = trpc.products.list.useQuery();
  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";

  const utils = trpc.useUtils();
  const testSets = trpc.testSets.listByProduct.useQuery({ productId });
  const createTestSet = trpc.testSets.create.useMutation({
    onSuccess: () => utils.testSets.listByProduct.invalidate({ productId }),
  });
  const deleteTestSet = trpc.testSets.delete.useMutation({
    onSuccess: () => utils.testSets.listByProduct.invalidate({ productId }),
  });

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div className="p-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">{productName} / Test sets</p>
          <h2 className="mt-0.5 font-heading text-[34px] leading-[1.05] tracking-tight">Test sets</h2>
        </div>
        <Button type="button" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
          <Plus />
          New test set
        </Button>
      </div>

      {showCreateForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createTestSet.mutate(
              { productId, name, description: description || undefined },
              {
                onSuccess: () => {
                  setName("");
                  setDescription("");
                  setShowCreateForm(false);
                },
              },
            );
          }}
          className="mt-4.5 space-y-3 border border-border bg-card p-4"
        >
          <h3 className="font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">New test set</h3>
          <Label className="flex-col items-start gap-1">
            Name
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Release smoke test" />
          </Label>
          <Label className="flex-col items-start gap-1">
            Description
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Label>
          {createTestSet.error && <p className="text-sm text-destructive">{createTestSet.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={createTestSet.isPending || !name.trim()}>
              {createTestSet.isPending ? "Creating..." : "Create test set"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {testSets.isLoading && <p className="mt-4 text-[13.5px] text-muted-foreground">Loading...</p>}
      {testSets.error && <p className="mt-4 text-sm text-destructive">{testSets.error.message}</p>}

      {testSets.data?.length ? (
        <Frame className="mt-4.5 bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[100px]">Tests</TableHead>
                <TableHead className="w-[130px]">Created</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {testSets.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Link href={`/test-sets/${s.id}`} className="hover:underline">
                      {s.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal text-muted-foreground">{s.description ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{s.itemCount}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(s.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={deleteTestSet.isPending}
                      onClick={() => {
                        if (confirm(`Delete test set "${s.name}"? This cannot be undone.`)) deleteTestSet.mutate({ id: s.id });
                      }}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Frame>
      ) : (
        !testSets.isLoading && (
          <p className="mt-4 text-[13.5px] text-muted-foreground">No test sets yet - create one above.</p>
        )
      )}
      {deleteTestSet.error && <p className="mt-2 text-sm text-destructive">{deleteTestSet.error.message}</p>}
    </div>
  );
}
