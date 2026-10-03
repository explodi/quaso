// SPDX-License-Identifier: MIT
/** The website: providers, the layout and the page for the address. */
import { StrictMode, useEffect } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Layout } from "./components/Layout.tsx";
import { Loading } from "./components/Spinner.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { matchRoutes } from "./lib/match.ts";
import { ParamsProvider, RouterProvider, useRoute } from "./lib/router.tsx";
import { SessionProvider, useSession } from "./lib/session.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { ROUTES } from "./routes.tsx";

function Page() {
  const { pathname, navigate } = useRoute();
  const session = useSession();
  const needsSetup = session.accounts && session.info.setupRequired;
  const redirecting = needsSetup && pathname !== "/setup";
  useEffect(() => {
    if (redirecting) navigate("/setup", { replace: true });
  }, [redirecting, navigate]);
  if (session.loading || redirecting) return <Loading label="Loading instance…" />;
  const match = matchRoutes(ROUTES, pathname);
  return (
    <Layout fill={match?.route.fill}>
      <ErrorBoundary resetKey={pathname}>
        {match ? (
          <ParamsProvider
            // Another language (say) is another page: its state starts afresh.
            key={`${match.route.path} ${JSON.stringify(match.params)}`}
            params={match.params}
          >
            {match.route.render(match.params)}
          </ParamsProvider>
        ) : (
          <NotFound />
        )}
      </ErrorBoundary>
    </Layout>
  );
}

export function App() {
  return (
    <StrictMode>
      <RouterProvider>
        <SessionProvider>
          <ToastProvider>
            <Page />
          </ToastProvider>
        </SessionProvider>
      </RouterProvider>
    </StrictMode>
  );
}
