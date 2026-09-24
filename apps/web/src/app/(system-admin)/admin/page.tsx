"use client";

import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc-client";
import { Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const RESULT_LIMIT = 50;

export default function AdminTenantsPage() {
  const [search, setSearch] = useState("");
  const utils = trpc.useUtils();
  const tenants = trpc.admin.listTenants.useQuery({ search });
  const setSuspended = trpc.admin.setTenantSuspended.useMutation({
    onSuccess: () => utils.admin.listTenants.invalidate(),
  });

  return (
    <div className="space-y-3">
      <div className="flex w-[280px] items-center gap-1.5 border border-border bg-card px-2.5 py-[5px]">
        <Search className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
        <DebouncedSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search organizations..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {tenants.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {(tenants.error || (!tenants.isLoading && !tenants.data)) && (
        <p className="text-sm text-destructive">{tenants.error?.message}</p>
      )}

      {tenants.data && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link href={`/admin/tenants/${t.id}`} className="font-medium text-foreground underline underline-offset-2">
                      {t.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.memberCount}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(t.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>{t.suspended ? <Badge variant="destructive">Suspended</Badge> : <Badge>Active</Badge>}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSuspended.mutate({ tenantId: t.id, suspended: !t.suspended })}
                    >
                      {t.suspended ? "Reactivate" : "Suspend"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {tenants.data.length === RESULT_LIMIT && (
            <p className="text-xs text-muted-foreground">
              Showing the {RESULT_LIMIT} most recently created organizations. Search to narrow further.
            </p>
          )}
        </>
      )}
    </div>
  );
}
