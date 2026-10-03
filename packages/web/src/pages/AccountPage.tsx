// SPDX-License-Identifier: MIT
import { H1, H2, H3 } from "../components/Typography.tsx";
/** Account credentials, linked sign-in methods and privacy-preserving deletion. */
import { useState } from "react";
import { Button, AnchorButton } from "../components/Button.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Field } from "../components/Field.tsx";
import { Access, ConfirmButton } from "../components/Management.tsx";
import { useToast } from "../components/Toast.tsx";
import { browserAuthUrl } from "../lib/api.ts";
import { useMutation } from "../lib/data.ts";
import { fieldError } from "../lib/forms.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { deleteAccount, unlinkIdentity, updateAccount } from "../lib/management-api.ts";
import { useRoute } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";

function Account() {
  useDocumentTitle("Account");
  const session = useSession();
  const user = session.user!;
  const toast = useToast();
  const { navigate } = useRoute();
  const [name, setName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email ?? "");
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const update = useMutation(updateAccount, {
    onSuccess: async () => {
      setCurrent("");
      setPassword("");
      await session.refresh();
      toast.show("Account saved.");
    },
  });
  const unlink = useMutation(unlinkIdentity, {
    onSuccess: async () => {
      await session.refresh();
      toast.show("Sign-in method unlinked.");
    },
  });
  const remove = useMutation(deleteAccount, {
    onSuccess: async () => {
      await session.refresh();
      navigate("/", { replace: true });
      toast.show("Your account has been deleted.");
    },
  });
  return (
    <div className="page narrow management-page">
      <H1>Account</H1>
      <section className="management-section">
        <H2>Your details</H2>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            update
              .run({
                displayName: name.trim(),
                email: email !== (user.email ?? "") ? email : undefined,
                password: password || undefined,
                currentPassword: current || undefined,
              })
              .catch(() => {});
          }}
        >
          {update.error !== undefined && <ErrorMessage error={update.error} />}
          <Field
            label="Display name"
            value={name}
            required
            maxLength={80}
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
            error={fieldError(update.error, "displayName")}
          />
          <Field
            label="Email address"
            value={email}
            type="email"
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            error={fieldError(update.error, "email")}
          />
          <Field
            label="New password"
            type="password"
            value={password}
            minLength={10}
            maxLength={256}
            autoComplete="new-password"
            hint="Leave empty to keep your password. New passwords need at least 10 characters."
            onChange={(e) => setPassword(e.target.value)}
            error={fieldError(update.error, "password")}
          />
          {user.hasPassword && (
            <Field
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={current}
              required={password !== "" || email !== (user.email ?? "")}
              onChange={(e) => setCurrent(e.target.value)}
              hint="Required when changing your email or password."
              error={fieldError(update.error, "currentPassword")}
            />
          )}
          <Button type="submit" variant="primary" busy={update.pending}>
            Save account
          </Button>
        </form>
      </section>
      <section className="management-section">
        <H2>Linked sign-in methods</H2>
        {unlink.error !== undefined && <ErrorMessage error={unlink.error} />}
        {(["github", "discord"] as const).map((provider) => {
          const linked = user.identities.find((identity) => identity.provider === provider);
          const label = provider === "github" ? "GitHub" : "Discord";
          return (
            <div className="record-card" key={provider}>
              <H3>{label}</H3>
              {linked ? (
                <>
                  <p>{linked.username ?? "Linked"}</p>
                  <ConfirmButton
                    title={`Unlink ${label}?`}
                    description="You will need another linked method or your email and password to sign in."
                    disabled={unlink.pending}
                    onConfirm={() => unlink.run(provider)}
                  >
                    Unlink {label}
                  </ConfirmButton>
                </>
              ) : session.info.providers[provider] ? (
                <AnchorButton href={`${browserAuthUrl(`/auth/${provider}`)}?link=1`}>
                  Link {label}
                </AnchorButton>
              ) : (
                <p className="muted">Not configured on this server.</p>
              )}
            </div>
          );
        })}
      </section>
      <section className="management-section">
        <H2>Delete account</H2>
        <p>Your contributed translations remain part of the project.</p>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          Delete my account
        </Button>
      </section>
      <Dialog
        open={deleting}
        onClose={() => {
          if (!remove.pending) {
            setDeleting(false);
            setConfirm("");
            setDeletePassword("");
            remove.reset();
          }
        }}
        title="Delete your account?"
      >
        <p>
          Your email, password, linked sign-in methods, sessions and pending suggestions will be
          deleted. Contributed translations stay, attributed to “Deleted user”. This cannot be
          undone.
        </p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            remove
              .run({ confirm: confirm as "delete", password: deletePassword || undefined })
              .catch(() => {});
          }}
        >
          <Field
            label="Type delete to confirm"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            error={fieldError(remove.error, "confirm")}
          />
          {user.hasPassword && (
            <Field
              label="Password to delete account"
              type="password"
              required
              value={deletePassword}
              autoComplete="current-password"
              onChange={(e) => setDeletePassword(e.target.value)}
              error={fieldError(remove.error, "password")}
            />
          )}
          {remove.error !== undefined && <ErrorMessage error={remove.error} />}
          <Button
            type="submit"
            variant="danger"
            disabled={confirm !== "delete"}
            busy={remove.pending}
          >
            Permanently delete account
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
export function AccountPage() {
  return (
    <Access>
      <Account />
    </Access>
  );
}
