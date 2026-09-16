import { createAuthClient } from "better-auth/react";

// No baseURL - the browser talks to whatever origin served the page, which is exactly
// where /api/auth/[...all] lives.
export const authClient = createAuthClient();
