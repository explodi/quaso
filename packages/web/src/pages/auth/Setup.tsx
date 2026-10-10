// SPDX-License-Identifier: MIT
import { Fieldset, Button, Notice, Field, InfoIcon } from "@quaso/design-system";
/**
 * Initial setup asks for the operator key before creating the first administrator.
 */
import { type FormEvent, useState } from "react";
import { ButtonLink } from "../../components/Button.tsx";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { useToast } from "../../components/Toast.tsx";
import { setUp } from "../../lib/api.ts";
import { useMutation } from "../../lib/data.ts";
import { useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { AuthCard, NoAccounts, PASSWORD_MIN, passwordHint } from "./AuthCard.tsx";

export function Setup() {
  const session = useSession();
  const toast = useToast();
  const { navigate } = useRoute();
  const [token, setToken] = useState("");
  const [form, setForm] = useState({
    displayName: "",
    email: "",
    password: "",
    projectName: "",
    sourceLanguage: "en",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useMutation(setUp, {
    onSuccess: async () => {
      await session.refresh();
      toast.show("Quaso is set up. Welcome!");
      navigate("/", { replace: true });
    },
  });

  const change = (name: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [name]: event.target.value });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ([...form.password].length < PASSWORD_MIN) {
      setProblem(`The password needs at least ${PASSWORD_MIN} characters.`);
      return;
    }
    setProblem(null);
    mutation
      .run({
        token,
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        password: form.password,
        projectName: form.projectName.trim(),
        sourceLanguage: form.sourceLanguage.trim() || undefined,
      })
      .catch(() => {});
  };

  if (session.accounts && !session.loading && !session.info.setupRequired) {
    return (
      <AuthCard title="Set up Quaso">
        <Notice kind="info" icon={<InfoIcon />} title="Already set up">
          <p>This instance has its administrator. Sign in instead.</p>
          <ButtonLink to="/signin" variant="primary">
            Sign in
          </ButtonLink>
        </Notice>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set up Quaso" description="Create your project and its first administrator.">
      <NoAccounts />
      {!session.info.setupKeyConfigured ? (
        <p>
          Set SETUP_KEY to at least 16 random characters in the deployment configuration, then
          restart Quaso and reload this page.
        </p>
      ) : (
        <form className="form" onSubmit={submit}>
          <p>Create the first administrator's account and name the project.</p>
          <Field
            label="Setup key"
            type="password"
            required
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
          <Fieldset className="fieldset">
            <legend>The project</legend>
            <Field
              label="Project name"
              required
              maxLength={120}
              value={form.projectName}
              onChange={change("projectName")}
            />
            <Field
              label="Source language"
              required
              value={form.sourceLanguage}
              onChange={change("sourceLanguage")}
              hint="The language the team writes in, as a language tag: en, de, pt-BR…"
            />
          </Fieldset>
          <Fieldset className="fieldset">
            <legend>Your account</legend>
            <Field
              label="Display name"
              autoComplete="nickname"
              required
              maxLength={80}
              value={form.displayName}
              onChange={change("displayName")}
            />
            <Field
              label="Email address"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={change("email")}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={change("password")}
              hint={passwordHint(form.password)}
              error={problem}
            />
          </Fieldset>
          <Button type="submit" variant="primary" className="btn-block" busy={mutation.pending}>
            Create the administrator
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
