// SPDX-License-Identifier: MIT
/** Uses Wrangler's current credentials without displaying or persisting them. */
import type { Fetch } from "../../core/mod.ts";

export interface Identity {
  loggedIn: boolean;
  accounts: { id: string; name: string }[];
}
export type Credentials =
  | { type: "oauth" | "api_token"; token: string }
  | { type: "api_key"; key: string; email: string };
export type WranglerRun = (
  args: string[],
  inherit?: boolean,
) => Promise<{ code: number; stdout: string }>;

export async function runWrangler(args: string[], inherit = false) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "npm:wrangler", ...args],
    cwd: new URL("../", import.meta.url),
    stdin: "inherit",
    stdout: inherit ? "inherit" : "piped",
    stderr: inherit ? "inherit" : "piped",
    // Wrangler's token command otherwise copies its JSON output into a diagnostic log.
    env: {
      WRANGLER_LOG_SANITIZE: "true",
      ...(args[0] === "auth" ? { WRANGLER_WRITE_LOGS: "false" } : {}),
    },
  }).output();
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout) };
}

export async function connectCloudflare(run: WranglerRun = runWrangler, request: Fetch = fetch) {
  let who = await run(["whoami", "--json"]);
  let identity = parseIdentity(who.stdout);
  if (!identity.loggedIn) {
    const login = await run(["login"], true);
    if (login.code !== 0) throw new Error("Wrangler login failed.");
    who = await run(["whoami", "--json"]);
    identity = parseIdentity(who.stdout);
  }
  if (who.code !== 0 || !identity.loggedIn) throw new Error("Wrangler is not authenticated.");
  const auth = await run(["auth", "token", "--json"]);
  if (auth.code !== 0) throw new Error("Couldn't read Wrangler credentials. Run wrangler login.");
  let credentials: Credentials;
  try {
    const value = JSON.parse(auth.stdout);
    const token =
      (value.type === "oauth" || value.type === "api_token") &&
      typeof value.token === "string" &&
      value.token.length > 0;
    const key =
      value.type === "api_key" && typeof value.key === "string" && typeof value.email === "string";
    if (!token && !key) throw new Error();
    credentials = value;
  } catch {
    throw new Error("Wrangler did not return valid credentials.");
  }
  return { identity, api: new CloudflareApi(credentials, request) };
}

function parseIdentity(text: string): Identity {
  try {
    const value = JSON.parse(text);
    if (value.loggedIn === false) return { loggedIn: false, accounts: [] };
    const validAccounts =
      Array.isArray(value.accounts) &&
      value.accounts.every(
        (account: { id?: unknown; name?: unknown }) =>
          typeof account.id === "string" && typeof account.name === "string",
      );
    if (value.loggedIn !== true || !validAccounts) throw new Error();
    return value;
  } catch {
    throw new Error(
      "Couldn't read the Cloudflare account list. Check Wrangler login and network access.",
    );
  }
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number }[];
  result_info?: { total_pages?: number };
}
export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
    codes: number[] = [],
  ) {
    super(
      `Cloudflare request ${path} failed (HTTP ${status}${codes.length ? `; codes ${codes.join(", ")}` : ""}).`,
    );
  }
}

export class CloudflareApi {
  private headers: Headers;
  constructor(
    credentials: Credentials,
    private fetch: Fetch = globalThis.fetch,
  ) {
    this.headers = new Headers();
    if (credentials.type === "api_key") {
      this.headers.set("X-Auth-Key", credentials.key);
      this.headers.set("X-Auth-Email", credentials.email);
    } else this.headers.set("Authorization", `Bearer ${credentials.token}`);
  }
  private async envelope<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Use a Cloudflare API path.");
    const headers = new Headers(this.headers);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const response = await this.fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    let body: Envelope<T>;
    try {
      body = (await response.json()) as Envelope<T>;
    } catch {
      throw new CloudflareApiError(response.status, path);
    }
    if (!response.ok || body.success !== true)
      throw new CloudflareApiError(
        response.status,
        path,
        body.errors?.map((error) => error.code),
      );
    return body;
  }
  async get<T>(path: string): Promise<T> {
    return (await this.envelope<T>(path)).result;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    return (
      await this.envelope<T>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).result;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    return (
      await this.envelope<T>(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).result;
  }
  async delete(path: string): Promise<void> {
    await this.envelope(path, { method: "DELETE" });
  }
  async list<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let page = 1;
    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.envelope<T[]>(`${path}${separator}page=${page}&per_page=100`);
      if (!Array.isArray(response.result))
        throw new Error(`Cloudflare did not return a list for ${path}.`);
      values.push(...response.result);
      if (page >= (response.result_info?.total_pages ?? 1)) return values;
      page++;
    }
  }
}
