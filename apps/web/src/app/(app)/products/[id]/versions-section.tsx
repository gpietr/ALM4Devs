"use client";

import { Frame } from "@/components/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { Plus } from "lucide-react";
import { useState } from "react";

/**
 * A product's own release train ("v1.0", "v1.1", ...) - just the list for now (number,
 * description, release date). Requirements, test cases, and OTS component versions each
 * get their own "applies to versions" picker on their own detail pages (see
 * software-version-picker.tsx) rather than anything here - this section stays a plain
 * list, same spirit as requirements-section.tsx's create-form-plus-table but without
 * levels, search, or a column picker, since there's nothing here to filter yet.
 */
export function VersionsSection({ productId }: { productId: string }) {
  const products = trpc.products.list.useQuery();
  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";

  const utils = trpc.useUtils();
  const versions = trpc.softwareVersions.listByProduct.useQuery({ productId });
  const createVersion = trpc.softwareVersions.create.useMutation({
    onSuccess: () => utils.softwareVersions.listByProduct.invalidate({ productId }),
  });
  const deleteVersion = trpc.softwareVersions.delete.useMutation({
    onSuccess: () => utils.softwareVersions.listByProduct.invalidate({ productId }),
  });

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [versionNumber, setVersionNumber] = useState("");
  const [description, setDescription] = useState("");
  const [releaseDate, setReleaseDate] = useState("");

  return (
    <div className="p-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">{productName} / Versions</p>
          <h2 className="mt-0.5 font-heading text-[34px] leading-[1.05] tracking-tight">Versions</h2>
        </div>
        <Button type="button" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
          <Plus />
          New version
        </Button>
      </div>

      {showCreateForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createVersion.mutate(
              { productId, versionNumber, description: description || undefined, releaseDate: releaseDate || undefined },
              {
                onSuccess: () => {
                  setVersionNumber("");
                  setDescription("");
                  setReleaseDate("");
                  setShowCreateForm(false);
                },
              },
            );
          }}
          className="mt-4.5 space-y-3 border border-border bg-card p-4"
        >
          <h3 className="font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">New version</h3>
          <Label className="flex-col items-start gap-1">
            Version number
            <Input required value={versionNumber} onChange={(e) => setVersionNumber(e.target.value)} placeholder="e.g. 1.1.0" />
          </Label>
          <Label className="flex-col items-start gap-1">
            Description
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Label>
          <Label className="flex-col items-start gap-1">
            Release date
            <Input type="date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} />
          </Label>
          {createVersion.error && <p className="text-sm text-destructive">{createVersion.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={createVersion.isPending || !versionNumber.trim()}>
              {createVersion.isPending ? "Creating..." : "Create version"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {versions.isLoading && <p className="mt-4 text-[13.5px] text-muted-foreground">Loading...</p>}
      {versions.error && <p className="mt-4 text-sm text-destructive">{versions.error.message}</p>}

      {versions.data?.length ? (
        <Frame className="mt-4.5 bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Version</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[130px]">Release date</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.data.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-[13px] font-medium">{v.versionNumber}</TableCell>
                  <TableCell className="max-w-md whitespace-normal text-muted-foreground">{v.description ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {v.releaseDate ? new Date(v.releaseDate).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={deleteVersion.isPending}
                      onClick={() => {
                        if (confirm(`Delete version ${v.versionNumber}?`)) deleteVersion.mutate({ id: v.id });
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
        !versions.isLoading && (
          <p className="mt-4 text-[13.5px] text-muted-foreground">No versions yet - create one above.</p>
        )
      )}
      {deleteVersion.error && <p className="mt-2 text-sm text-destructive">{deleteVersion.error.message}</p>}
    </div>
  );
}
