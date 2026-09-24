"use client";

import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc-client";
import { Search } from "lucide-react";
import { useState } from "react";

const RESULT_LIMIT = 50;

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const users = trpc.admin.listUsers.useQuery({ search });

  return (
    <div className="space-y-3">
      <div className="flex w-[280px] items-center gap-1.5 border border-border bg-card px-2.5 py-[5px]">
        <Search className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
        <DebouncedSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name, email, or organization..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {users.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {(users.error || (!users.isLoading && !users.data)) && (
        <p className="text-sm text-destructive">{users.error?.message}</p>
      )}

      {users.data && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      {u.name}
                      {u.isSystemAdmin && <Badge>System admin</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{u.email}</TableCell>
                  <TableCell className="text-muted-foreground">{u.tenantName}</TableCell>
                  <TableCell className="capitalize">{u.role}</TableCell>
                  <TableCell>{u.removedAt ? <Badge variant="destructive">Removed</Badge> : <Badge variant="outline">Active</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {users.data.length === RESULT_LIMIT && (
            <p className="text-xs text-muted-foreground">
              Showing the {RESULT_LIMIT} most recently created users. Search to narrow further.
            </p>
          )}
        </>
      )}
    </div>
  );
}
