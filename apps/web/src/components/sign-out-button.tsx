"use client";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full"
      onClick={async () => {
        await authClient.signOut();
        router.push("/log-in");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
