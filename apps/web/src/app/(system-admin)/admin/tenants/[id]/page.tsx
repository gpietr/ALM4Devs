"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc-client";
import { use, useEffect, useState } from "react";

type OrgRole = "admin" | "member";

export default function AdminTenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: tenantId } = use(params);
  const utils = trpc.useUtils();
  const tenant = trpc.admin.getTenant.useQuery({ tenantId });
  const [name, setName] = useState("");

  const rename = trpc.admin.renameTenant.useMutation({ onSuccess: () => utils.admin.getTenant.invalidate({ tenantId }) });
  const setSuspended = trpc.admin.setTenantSuspended.useMutation({
    onSuccess: () => utils.admin.getTenant.invalidate({ tenantId }),
  });
  const setSystemAdmin = trpc.admin.setUserSystemAdmin.useMutation({
    onSuccess: () => utils.admin.getTenant.invalidate({ tenantId }),
  });
  const setRole = trpc.admin.setUserRole.useMutation({ onSuccess: () => utils.admin.getTenant.invalidate({ tenantId }) });

  useEffect(() => {
    if (tenant.data?.tenant) setName(tenant.data.tenant.name);
  }, [tenant.data?.tenant]);

  if (tenant.isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (tenant.error || !tenant.data?.tenant) return <p className="text-sm text-destructive">{tenant.error?.message}</p>;

  const { tenant: t, members } = tenant.data;

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center gap-2">
        {t.suspended ? <Badge variant="destructive">Suspended</Badge> : <Badge>Active</Badge>}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSuspended.mutate({ tenantId, suspended: !t.suspended })}
        >
          {t.suspended ? "Reactivate" : "Suspend"}
        </Button>
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate({ tenantId, name });
        }}
      >
        <Label className="flex-col items-start gap-1">
          <span className="text-sm font-medium text-foreground">Organization name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Label>
        <Button type="submit" disabled={rename.isPending || !name.trim()}>
          Save
        </Button>
      </form>

      <div className="space-y-3">
        <h3 className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">
          Users ({members.length})
        </h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>System admin</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.name}</TableCell>
                <TableCell className="text-muted-foreground">{m.email}</TableCell>
                <TableCell>
                  {m.removedAt ? (
                    <span className="capitalize text-muted-foreground">{m.role}</span>
                  ) : (
                    <Select
                      value={m.role}
                      onValueChange={(role) => setRole.mutate({ userId: m.id, tenantId, role: role as OrgRole })}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="member">Member</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
                <TableCell>{m.removedAt ? <Badge variant="destructive">Removed</Badge> : <Badge variant="outline">Active</Badge>}</TableCell>
                <TableCell>{m.isSystemAdmin && <Badge>System admin</Badge>}</TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSystemAdmin.mutate({ userId: m.id, isSystemAdmin: !m.isSystemAdmin })}
                  >
                    {m.isSystemAdmin ? "Demote" : "Promote"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
