"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

type OrgRole = "admin" | "member";

export default function MembersSettingsPage() {
  const session = authClient.useSession();
  const isAdmin = (session.data?.user as { role?: string } | undefined)?.role === "admin";

  const utils = trpc.useUtils();
  const members = trpc.members.list.useQuery();

  const updateRole = trpc.members.updateRole.useMutation({ onSuccess: () => utils.members.list.invalidate() });
  const remove = trpc.members.remove.useMutation({ onSuccess: () => utils.members.list.invalidate() });
  const revoke = trpc.members.revokeInvitation.useMutation({ onSuccess: () => utils.members.list.invalidate() });

  const [inviteOpen, setInviteOpen] = useState(false);

  if (members.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (members.error || !members.data) {
    return <p className="text-sm text-destructive">{members.error?.message}</p>;
  }

  const { members: activeMembers, pendingInvitations } = members.data;

  return (
    <div>
      <SettingsSectionHeader title="Members" description="Everyone with access to this organization." />

      <div className="max-w-3xl space-y-8">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Active</h3>
            {isAdmin && <Button size="sm" onClick={() => setInviteOpen(true)}>Invite member</Button>}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                {isAdmin && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeMembers.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.name}</TableCell>
                  <TableCell className="text-muted-foreground">{m.email}</TableCell>
                  <TableCell>
                    {isAdmin ? (
                      <Select
                        value={m.role}
                        onValueChange={(role) => updateRole.mutate({ userId: m.id, role: role as OrgRole })}
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="capitalize">{m.role}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(m.createdAt).toLocaleDateString()}</TableCell>
                  {isAdmin && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (confirm(`Remove ${m.name} from this organization?`)) remove.mutate({ userId: m.id });
                        }}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {(isAdmin || pendingInvitations.length > 0) && (
          <div className="space-y-3">
            <h3 className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">
              Pending invitations
            </h3>
            {pendingInvitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Invited by</TableHead>
                    <TableHead>Expires</TableHead>
                    {isAdmin && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingInvitations.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>{inv.email}</TableCell>
                      <TableCell className="capitalize">{inv.role}</TableCell>
                      <TableCell className="text-muted-foreground">{inv.invitedByName}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(inv.expiresAt).toLocaleDateString()}</TableCell>
                      {isAdmin && (
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => revoke.mutate({ invitationId: inv.id })}>
                            Revoke
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>

      {isAdmin && <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />}
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const invite = trpc.members.invite.useMutation({
    onSuccess: () => {
      utils.members.list.invalidate();
      setEmail("");
      setRole("member");
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({ email, role });
          }}
        >
          <Label className="flex-col items-start gap-1">
            <span className="text-sm font-medium text-foreground">Email</span>
            <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" />
          </Label>
          <Label className="flex-col items-start gap-1">
            <span className="text-sm font-medium text-foreground">Role</span>
            <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {invite.error && <p className="text-sm text-destructive">{invite.error.message}</p>}
          <DialogFooter>
            <Button type="submit" disabled={invite.isPending || !email.trim()}>
              {invite.isPending ? "Sending..." : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
