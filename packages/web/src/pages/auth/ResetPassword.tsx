// SPDX-License-Identifier: MIT
/** Choosing a new password with a reset link (`/reset-password?token=`). */
import { type FormEvent, useState } from "react";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { ErrorMessage, Notice } from "../../components/ErrorMessage.tsx";
import { Field } from "../../components/Field.tsx";
import { CheckIcon } from "../../components/Icons.tsx";
import { resetPassword } from "../../lib/api.ts";
import { useMutation } from "../../lib/data.ts";
import { useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { AuthCard, NoAccounts, PASSWORD_MIN, passwordHint } from "./AuthCard.tsx";

export function ResetPassword() {
  const session = useSession();
  const { query } = useRoute();
  const token = query.token ?? "";
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mutation = useMutation(resetPassword, {
    onSuccess: async () => {
      setDone(true);
      await session.refresh();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ([...password].length < PASSWORD_MIN) {
      setProblem(`The password needs at least ${PASSWORD_MIN} characters.`);
    } else if (password !== repeat) {
      setProblem("The two passwords differ.");
    } else {
      setProblem(null);
      mutation.run({ token, password }).catch(() => {});
    }
  };

  return (
    <AuthCard title="Choose a new password">
      <NoAccounts />
      {token === "" ? (
        <p>
          This link has no token. Open the whole link from the email or from your administrator.
        </p>
      ) : done ? (
        <Notice kind="success" icon={<CheckIcon />} title="Password changed">
          <p>Your new password works from now on.</p>
          <ButtonLink to={session.user ? "/" : "/signin"} variant="primary">
            {session.user ? "Go to the dashboard" : "Sign in"}
          </ButtonLink>
        </Notice>
      ) : (
        <form className="form" onSubmit={submit}>
          {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={passwordHint(password)}
          />
          <Field
            label="The same password again"
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            error={problem}
          />
          <Button type="submit" variant="primary" className="btn-block" busy={mutation.pending}>
            Change the password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
