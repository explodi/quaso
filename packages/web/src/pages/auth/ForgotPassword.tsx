// SPDX-License-Identifier: MIT
/**
 * A forgotten password (S7.2): with an email service, the server sends a reset link;
 * without one, an administrator creates a reset link on the Team page and passes it on.
 */
import { type FormEvent, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ErrorMessage, Notice } from "../../components/ErrorMessage.tsx";
import { Field } from "../../components/Field.tsx";
import { InfoIcon, MailIcon } from "../../components/Icons.tsx";
import { requestPasswordReset } from "../../lib/api.ts";
import { useMutation } from "../../lib/data.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { AuthCard, NoAccounts } from "./AuthCard.tsx";

export function ForgotPassword() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const mutation = useMutation(requestPasswordReset, { onSuccess: () => setSent(true) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.run({ email }).catch(() => {});
  };

  return (
    <AuthCard title="Forgot your password?" footer={<Link to="/signin">Back to signing in</Link>}>
      <NoAccounts />
      {!session.info.providers.email ? (
        <Notice kind="info" icon={<InfoIcon />} title="Ask an administrator">
          <p>
            This server doesn't send emails. An administrator of this project can create a password
            reset link for you on the Team page and pass it on.
          </p>
        </Notice>
      ) : sent ? (
        <Notice kind="success" icon={<MailIcon />} title="Check your email">
          <p>If an account uses {email}, we sent it a link to choose a new password.</p>
        </Notice>
      ) : (
        <form className="form" onSubmit={submit}>
          <p>We'll send you a link to choose a new password.</p>
          {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
          <Field
            label="Email address"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" variant="primary" className="btn-block" busy={mutation.pending}>
            Send the link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
