// SPDX-License-Identifier: MIT
/**
 * The session: who is signed in, their role and languages, the sign-in methods the server
 * offers, whether it still needs its first administrator and whether it is a development
 * instance. `can(action, language)` mirrors the service's permission table to show or hide
 * actions; the service still checks every request.
 */
import type { SessionInfo, UserInfo } from "@quaso/core";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
import { configureApi, getSession, SIGNED_OUT, signOut as apiSignOut } from "./api.ts";
import { queryCache, useQuery } from "./data.ts";
import { type Action, can as canDo } from "./permissions.ts";

export const SESSION_KEY = ["session"] as const;

export interface Session {
  info: SessionInfo;
  user: UserInfo | null;
  /** The server has accounts (its `/auth/session` exists). */
  accounts: boolean;
  /** The session hasn't loaded yet. */
  loading: boolean;
  can(action: Action, language?: string): boolean;
  /** Fetches the session again, after signing in, say, and refreshes everything else. */
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const query = useQuery(SESSION_KEY, getSession, { staleTime: 60_000 });
  // Without a session (still loading, or the request failed), the visitor is signed out.
  // (A server without accounts answers 404, which getSession reports as accounts: false.)
  const state = query.data ?? { info: SIGNED_OUT, accounts: true };
  const user = state.info.user;

  // A request answered 401: the session has probably ended (it expired, or the person
  // signed out in another tab). Ask again, so the header and the pages show it.
  useEffect(() => {
    configureApi({
      onUnauthorized: () => {
        if (!queryCache.get(SESSION_KEY).fetching) queryCache.invalidate(SESSION_KEY);
      },
    });
    return () => configureApi({ onUnauthorized: null });
  }, []);

  const refresh = useCallback(async () => {
    await queryCache.fetch(SESSION_KEY, getSession, { force: true });
    // What a page shows may depend on who is looking.
    await queryCache.invalidate([]);
  }, []);

  const signOut = useCallback(async () => {
    await apiSignOut();
    await refresh();
  }, [refresh]);

  const value = useMemo<Session>(
    () => ({
      info: state.info,
      user,
      accounts: state.accounts,
      loading: query.loading,
      can: (action, language) => canDo(user, action, language),
      refresh,
      signOut,
    }),
    [state.info, state.accounts, user, query.loading, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() needs a <SessionProvider>");
  return session;
}
