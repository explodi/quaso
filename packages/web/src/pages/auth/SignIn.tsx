// SPDX-License-Identifier: MIT
/**
 * Sign in (S7.2): email and password; GitHub and Discord when the server offers them; a
 * sign-in link by email when it has an email service; and, in development, one click.
 */
import { type FormEvent, useState } from "react";
import {
  Button,
  AnchorButton,
  Notice,
  Field,
  ChatIcon,
  GitHubIcon,
  MailIcon,
  UserIcon,
} from "@quaso/design-system";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { useToast } from "../../components/Toast.tsx";
import { ApiError, browserAuthUrl, requestEmailLink, signIn } from "../../lib/api.ts";
import { useMutation } from "../../lib/data.ts";
import { href, Link, safeNext, useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { AuthCard, NoAccounts } from "./AuthCard.tsx";

export function SignIn() {
  const session = useSession();
  const toast = useToast();
  const { query, navigate } = useRoute();
  const next = safeNext(query.next);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [linkMode, setLinkMode] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const providers = session.info.providers;

  const signInMutation = useMutation(signIn, {
    onSuccess: async () => {
      await session.refresh();
      toast.show("Signed in.");
      navigate(next, { replace: true });
    },
  });
  const linkMutation = useMutation(requestEmailLink, { onSuccess: () => setLinkSent(true) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (linkMode) linkMutation.run({ email }).catch(() => {});
    else signInMutation.run({ email, password }).catch(() => {});
  };

  const error = linkMode ? linkMutation.error : signInMutation.error;
  const wrongPassword = error instanceof ApiError && error.code === "unauthorized";

  if (session.user) {
    return (
      <AuthCard title="Sign in">
        <p>You are signed in as {session.user.displayName}.</p>
        <Link to={next}>Continue</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in"
      description="Pick up where your team left off."
      footer={
        <p>
          New here? <Link to={href("/signup", { next: query.next })}>Create an account</Link>
        </p>
      }
    >
      <NoAccounts />
      {session.info.dev && (
        <Notice kind="info" title="Development instance">
          <p>
            <AnchorButton href={browserAuthUrl("/auth/dev-login", next)}>
              <UserIcon /> Sign in as the developer
            </AnchorButton>
          </p>
        </Notice>
      )}
      {(providers.github || providers.discord) && (
        <div className="provider-buttons">
          {providers.github && (
            <AnchorButton className="btn-block" href={browserAuthUrl("/auth/github", next)}>
              <GitHubIcon /> Sign in with GitHub
            </AnchorButton>
          )}
          {providers.discord && (
            <AnchorButton className="btn-block" href={browserAuthUrl("/auth/discord", next)}>
              <ChatIcon /> Sign in with Discord
            </AnchorButton>
          )}
          <p className="divider">
            <span>or</span>
          </p>
        </div>
      )}
      {linkSent ? (
        <Notice kind="success" icon={<MailIcon />} title="Check your email">
          <p>
            If an account uses {email}, we sent it a link to sign in. It works once, for a short
            while.
          </p>
        </Notice>
      ) : (
        <form className="form" onSubmit={submit}>
          {error !== undefined &&
            (wrongPassword ? (
              <p className="field-error" role="alert">
                The email address or the password is wrong.
              </p>
            ) : (
              <ErrorMessage error={error} />
            ))}
          <Field
            label="Email address"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {!linkMode && (
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
          <Button
            type="submit"
            variant="primary"
            className="btn-block"
            busy={signInMutation.pending || linkMutation.pending}
          >
            {linkMode ? "Email me a sign-in link" : "Sign in"}
          </Button>
        </form>
      )}
      <div className="auth-links">
        {providers.email && !linkSent && (
          <Button
            variant="plain"
            type="button"
            className="link-button"
            onClick={() => setLinkMode(!linkMode)}
          >
            {linkMode ? "Sign in with a password instead" : "Sign in with a link by email"}
          </Button>
        )}
        <Link to="/forgot-password">Forgot your password?</Link>
      </div>
    </AuthCard>
  );
}
