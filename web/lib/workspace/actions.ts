"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { myWorkspaces, WORKSPACE_COOKIE } from "./context";

/**
 * Switch the workspace the UI is showing.
 *
 * Validated against membership before the cookie is written — not because the
 * cookie is a security boundary (RLS is), but so a stale or hand-edited value
 * fails here with a clear message instead of silently rendering an empty app.
 */
export async function switchWorkspace(workspaceId: string): Promise<void> {
  const all = await myWorkspaces();
  if (!all.some((w) => w.id === workspaceId)) {
    throw new Error("You are not a member of that workspace.");
  }

  const jar = await cookies();
  jar.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  // Every page's data is workspace-scoped, so the whole shell is stale.
  revalidatePath("/", "layout");
}
