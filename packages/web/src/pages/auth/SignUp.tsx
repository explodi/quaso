// SPDX-License-Identifier: MIT
/**
 * Create an account (S7.2): email, password (at least 10 characters) and a display name.
 * An invite link's token (`?invite=`) is checked and passed on, and says the role it gives.
 */
import type { InviteCheck } from "@quaso/core";
import { type FormEvent, useState } from "react";
import { Button, Notice, Field, InfoIcon } from "@quaso/design-system";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { useToast } from "../../components/Toast.tsx";
import { ApiError, checkInvite, signUp } from "../../lib/api.ts";
import { useMutation, useQuery } from "../../lib/data.ts";
import { languageLabel } from "../../lib/format.ts";
import { roleLabel } from "../../lib/permissions.ts";
import { href, Link, safeNext, useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { AuthCard, NoAccounts, PASSWORD_MIN, passwordHint } from "./AuthCard.tsx";
import { HumanCheck } from "../../components/HumanCheck.tsx";

function InviteInfo({ token }: { token: string }) {
  const invite = useQuery<InviteCheck>(["invite", token], () => checkInvite(token), {
    staleTime: 60_000,
  });
  if (invite.loading) return null;
  if (invite.error !== undefined) {
    if (invite.error instanceof ApiError && invite.error.missingEndpoint) return null;
    return <ErrorMessage error={invite.error} title="The invite couldn't be checked" />;
  }
  const data = invite.data!;
  if (!data.valid || !data.role) {
    return (
      <Notice kind="warning" icon={<InfoIcon />} title="This invite link doesn't work">
        <p>It has expired or was already used. You can still create an account without it.</p>
      </Notice>
    );
  }
  const languages = data.languages?.map(languageLabel).join(", ");
  return (
    <Notice kind="success" icon={<InfoIcon />} title="You were invited">
      <p>
        Your account will have the role {roleLabel(data.role)}
        {languages ? `, for ${languages}` : ""}.
      </p>
    </Notice>
  );
}

export function SignUp() {
  const session = useSession();
  const toast = useToast();
  const { query, navigate } = useRoute();
  const invite = query.invite;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tooShort, setTooShort] = useState(false);
  const [humanCheck, setHumanCheck] = useState("");

  const mutation = useMutation(signUp, {
    onSuccess: async () => {
      await session.refresh();
      toast.show(
        session.info.providers.email
          ? "Account created. Check your email to confirm your address."
          : "Account created.",
      );
      navigate(safeNext(query.next), { replace: true });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ([...password].length < PASSWORD_MIN) {
      setTooShort(true);
      return;
    }
    mutation
      .run({
        email,
        password,
        displayName: displayName.trim(),
        invite,
        humanCheck: humanCheck || undefined,
      })
      .catch(() => {});
  };

  return (
    <AuthCard
      title="Create an account"
      footer={
        <p>
          Already have one? <Link to={href("/signin", { next: query.next })}>Sign in</Link>
        </p>
      }
    >
      <NoAccounts />
      {invite && <InviteInfo token={invite} />}
      <form className="form" onSubmit={submit}>
        {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
        <Field
          label="Display name"
          autoComplete="nickname"
          required
          maxLength={80}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          hint="Shown next to your translations."
        />
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          maxLength={256}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setTooShort(false);
          }}
          hint={passwordHint(password)}
          error={tooShort ? `The password needs at least ${PASSWORD_MIN} characters.` : null}
        />
        <HumanCheck onToken={setHumanCheck} />
        <Button
          type="submit"
          variant="primary"
          className="btn-block"
          busy={mutation.pending}
          disabled={!!session.info.humanCheck && !humanCheck}
        >
          Create the account
        </Button>
      </form>
    </AuthCard>
  );
}
