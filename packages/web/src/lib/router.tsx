// SPDX-License-Identifier: MIT
import { A } from "../components/Controls.tsx";
/**
 * A small router on the History API (design §5.9: a dozen pages don't need a library):
 * routes with parameters, `<Link>`, `navigate()`, `useRoute()`, scroll restoration on back
 * and forward, and focus management: after each navigation, focus moves to the page's main
 * heading, so screen reader users hear where they are.
 */
import {
  type AnchorHTMLAttributes,
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildQuery, type Params, parseQuery, type QueryInput } from "./match.ts";

export * from "./match.ts";

export interface RouterLocation {
  pathname: string;
  search: string;
  hash: string;
  /** Identifies the history entry, for scroll restoration. */
  key: string;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /** Scroll to the top (or to the hash) after navigating. Default: true. */
  scroll?: boolean;
  /** Move focus to the new page's main heading. Default: true. */
  focus?: boolean;
}

type Navigate = (to: string, options?: NavigateOptions) => void;

interface RouterState {
  location: RouterLocation;
  action: "initial" | "push" | "replace" | "pop";
  scroll: boolean;
  focus: boolean;
}

interface RouterValue {
  location: RouterLocation;
  query: Record<string, string>;
  navigate: Navigate;
}

const RouterContext = createContext<RouterValue | null>(null);
const ParamsContext = createContext<Params>({});

function createKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readLocation(): RouterLocation {
  let key = (history.state as { key?: unknown } | null)?.key;
  if (typeof key !== "string") {
    key = createKey();
    history.replaceState({ ...(history.state ?? {}), key }, "");
  }
  return {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    key: key as string,
  };
}

/** Moves focus to the main heading (or the main landmark), without scrolling. */
export function focusMainHeading(): void {
  const target =
    document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("main");
  if (!target) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RouterState>(() => ({
    location: readLocation(),
    action: "initial",
    scroll: false,
    focus: false,
  }));
  const current = useRef(state);
  current.current = state;
  const positions = useRef(new Map<string, number>());

  useEffect(() => {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    const onPop = () => {
      // The browser has changed the address but not the scroll position yet.
      positions.current.set(current.current.location.key, globalThis.scrollY);
      setState({ location: readLocation(), action: "pop", scroll: true, focus: true });
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback<Navigate>((to, options = {}) => {
    let url = new URL(to, location.href);
    // Only pages of this website: an address from elsewhere (a `next` parameter, say)
    // never takes the tab to another site. Links to other sites are plain links.
    if (url.origin !== location.origin) url = new URL("/", location.href);
    const previous = current.current.location;
    const path = url.pathname + url.search + url.hash;
    if (path === previous.pathname + previous.search + previous.hash && !options.replace) return;
    positions.current.set(previous.key, globalThis.scrollY);
    const key = options.replace ? previous.key : createKey();
    if (options.replace) history.replaceState({ key }, "", path);
    else history.pushState({ key }, "", path);
    setState({
      location: { pathname: url.pathname, search: url.search, hash: url.hash, key },
      action: options.replace ? "replace" : "push",
      scroll: options.scroll ?? true,
      focus: options.focus ?? true,
    });
  }, []);

  useLayoutEffect(() => {
    const { action, location: here, scroll, focus } = state;
    if (action === "initial") return;
    if (scroll) {
      if (action === "pop") {
        const top = positions.current.get(here.key) ?? 0;
        scrollTo(0, top);
        // Data from the cache renders at once; give late layout one more frame.
        requestAnimationFrame(() => scrollTo(0, top));
      } else if (here.hash) {
        document.getElementById(decodeURIComponent(here.hash.slice(1)))?.scrollIntoView();
      } else {
        scrollTo(0, 0);
      }
    }
    if (focus) focusMainHeading();
  }, [state]);

  const value = useMemo<RouterValue>(
    () => ({
      location: state.location,
      query: parseQuery(state.location.search),
      navigate,
    }),
    [state.location, navigate],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRoute() needs a <RouterProvider>");
  return value;
}

/** Provides the matched route's parameters to the page. */
export function ParamsProvider({ params, children }: { params: Params; children: ReactNode }) {
  return <ParamsContext.Provider value={params}>{children}</ParamsContext.Provider>;
}

export interface Route {
  location: RouterLocation;
  pathname: string;
  /** The query string's values. */
  query: Record<string, string>;
  /** The matched route's parameters. */
  params: Params;
  navigate: Navigate;
  /**
   * Changes some query values and keeps the others, replacing the history entry, without
   * scrolling or moving focus: for filters and search boxes.
   */
  setQuery(patch: QueryInput, options?: NavigateOptions): void;
}

/** The current location, its query and the route's parameters. */
export function useRoute(): Route {
  const { location, query, navigate } = useRouter();
  const params = useContext(ParamsContext);
  const setQuery = useCallback(
    (patch: QueryInput, options: NavigateOptions = {}) => {
      const next = { ...parseQuery(location.search), ...patch };
      navigate(location.pathname + buildQuery(next), {
        replace: true,
        scroll: false,
        focus: false,
        ...options,
      });
    },
    [location.pathname, location.search, navigate],
  );
  return { location, pathname: location.pathname, query, params, navigate, setQuery };
}

/** `navigate(to, options)` */
export function useNavigate(): Navigate {
  return useRouter().navigate;
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  replace?: boolean;
  /** Keep the scroll position and focus, for links that only change the query. */
  quiet?: boolean;
}

/** Whether a click should be left to the browser: new tab, download, modifier keys… */
function isBrowserClick(event: MouseEvent<HTMLAnchorElement>, target?: string): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (target !== undefined && target !== "_self")
  );
}

/** A link within the website, navigating without reloading the page. */
export function Link({ to, replace, quiet, onClick, ...rest }: LinkProps) {
  const navigate = useNavigate();
  return (
    <A
      href={to}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (isBrowserClick(event, rest.target) || rest.download !== undefined) return;
        if (event.currentTarget.origin !== location.origin) return;
        event.preventDefault();
        navigate(to, quiet ? { replace, scroll: false, focus: false } : { replace });
      }}
    />
  );
}

export interface NavLinkProps extends LinkProps {
  /** Active only on this exact path, not below it. */
  exact?: boolean;
}

/** A navigation link that says when it is the current page (`aria-current="page"`). */
export function NavLink({ exact, ...props }: NavLinkProps) {
  const { location } = useRouter();
  const path = new URL(props.to, "http://x").pathname;
  const active = exact
    ? location.pathname === path
    : location.pathname === path ||
      location.pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
  return <Link {...props} aria-current={active ? "page" : undefined} />;
}

/** Goes somewhere else at once, replacing the history entry. */
export function Redirect({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => navigate(to, { replace: true }), [navigate, to]);
  return null;
}
