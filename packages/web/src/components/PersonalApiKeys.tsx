// SPDX-License-Identifier: MIT
/**
 * The account page's API keys: the signed-in person's own keys for the CLI. A key does what
 * its scope allows and its creator may do, so the section says which commands a key can run
 * for this person. Administrators manage everyone's keys in Settings as well.
 */
import { Button, Field, H2, H3, Label, Loading, Select } from "@quaso/design-system";
import { type ApiTokensResult, CreateApiTokenRequest, type CreatedApiToken } from "@quaso/core";
import { useState } from "react";
import { errorMessage, request } from "../lib/api.ts";
import { useQuery } from "../lib/data.ts";
import { fieldError, validated } from "../lib/forms.ts";
import { useSession } from "../lib/session.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { ConfirmButton, OneTimeSecret } from "./Management.tsx";

export function PersonalApiKeys() {
  const session = useSession();
  const user = session.user!;
  const tokens = useQuery(["api-tokens"], ({ fresh }) =>
    request<ApiTokensResult>("/api-tokens", { fresh }),
  );
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "upload">("upload");
  const [secret, setSecret] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>();
  // Administrators list everyone's keys; this page is about one's own.
  const own =
    tokens.data?.tokens.filter(
      (key) => key.createdBy?.type === "user" && key.createdBy.id === user.id,
    ) ?? [];
  const commands = [
    session.can("download") && "quaso download",
    session.can("upload") && "quaso upload",
    session.can("translate") && "quaso translate",
  ].filter((command) => command !== false);

  const create = async () => {
    setCreating(true);
    setError(undefined);
    try {
      const key = await request<CreatedApiToken>("/api-tokens", {
        method: "POST",
        body: validated(CreateApiTokenRequest, { name: name.trim(), scope }),
      });
      setSecret(key.secret);
      setName("");
      await tokens.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="management-section account-keys">
      <H2>API keys</H2>
      <p>
        The Quaso CLI signs in with an API key: put it in <code>QUASO_API_KEY</code>, in your
        environment or a <code>.env</code> file next to <code>quaso.config.json</code>. A key never
        does more than you may do: it follows your role, and stops working if your account is
        deleted.
      </p>
      {commands.length > 0 ? (
        <p>
          With your role, an upload key can run{" "}
          {commands.map((command, index) => (
            <span key={command}>
              {index > 0 && ", "}
              <code>{command}</code>
            </span>
          ))}
          ; a read key only reads{session.can("download") ? " and downloads" : ""}.
        </p>
      ) : (
        <p>Your role doesn't allow downloading, uploading or translating with the CLI yet.</p>
      )}
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {error !== undefined && <ErrorMessage error={error} />}
        <Field
          label="Key name"
          value={name}
          required
          maxLength={80}
          placeholder="Laptop"
          onChange={(e) => setName(e.target.value)}
          error={fieldError(error, "name")}
        />
        <Label className="field">
          Scope
          <Select
            value={scope}
            onChange={(e) => setScope(e.target.value === "read" ? "read" : "upload")}
          >
            <option value="upload">Upload: everything your role allows</option>
            <option value="read">Read: browse and download only</option>
          </Select>
        </Label>
        <Button type="submit" variant="primary" busy={creating}>
          Create API key
        </Button>
      </form>
      <OneTimeSecret value={secret} title="New API key" onClose={() => setSecret(null)} />
      {tokens.loading && <Loading />}
      {tokens.error !== undefined && <p role="alert">{errorMessage(tokens.error)}</p>}
      {tokens.data && own.length === 0 && <p>You have no API keys yet.</p>}
      {own.map((key) => (
        <article className="record-card" key={key.id}>
          <H3>{key.name}</H3>
          <p>
            <code>{key.prefix}</code> · {key.scope} · Created{" "}
            {new Date(key.createdAt).toLocaleString()} · Last used{" "}
            {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}
          </p>
          {key.revokedAt ? (
            <p>Revoked {new Date(key.revokedAt).toLocaleString()}</p>
          ) : (
            <ConfirmButton
              title={`Revoke ${key.name}?`}
              description="Anything using this key loses access immediately."
              onConfirm={async () => {
                try {
                  await request(`/api-tokens/${key.id}`, { method: "DELETE" });
                  await tokens.refresh();
                } catch (e) {
                  setError(e);
                  throw e;
                }
              }}
            >
              Revoke key
            </ConfirmButton>
          )}
        </article>
      ))}
    </section>
  );
}
