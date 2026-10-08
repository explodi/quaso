// SPDX-License-Identifier: MIT
/** Confirming an email address with the link the server sent (`/verify-email?token=`). */
import { useEffect, useRef, useState } from "react";
import { ButtonLink } from "../../components/Button.tsx";
import { Notice, CheckIcon, Spinner } from "@quaso/design-system";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { verifyEmail } from "../../lib/api.ts";
import { useMutation } from "../../lib/data.ts";
import { useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { AuthCard } from "./AuthCard.tsx";

export function VerifyEmail() {
  const session = useSession();
  const { query } = useRoute();
  const token = query.token ?? "";
  const [done, setDone] = useState(false);
  const mutation = useMutation(verifyEmail, {
    onSuccess: async () => {
      setDone(true);
      await session.refresh();
    },
  });
  const started = useRef(false);
  const run = mutation.run;

  useEffect(() => {
    // Once, even when React runs effects twice in development.
    if (started.current || token === "") return;
    started.current = true;
    run({ token }).catch(() => {});
  }, [token, run]);

  return (
    <AuthCard title="Confirm your email address">
      {token === "" && <p>This link has no token. Open the whole link from the email.</p>}
      {mutation.pending && <Spinner label="Confirming…" />}
      {mutation.error !== undefined && (
        <ErrorMessage error={mutation.error} title="The address couldn't be confirmed" />
      )}
      {done && (
        <Notice kind="success" icon={<CheckIcon />} title="Address confirmed">
          <p>Thank you.</p>
          <ButtonLink to="/" variant="primary">
            Go to the dashboard
          </ButtonLink>
        </Notice>
      )}
    </AuthCard>
  );
}
