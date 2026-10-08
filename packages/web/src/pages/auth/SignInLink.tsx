// SPDX-License-Identifier: MIT
/**
 * Signing in with a link sent by email (`/signin/link?token=`). It asks for a click first,
 * so a mail scanner that opens links doesn't use up the one-time link.
 */
import { Button } from "@quaso/design-system";
import { ButtonLink } from "../../components/Button.tsx";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { useToast } from "../../components/Toast.tsx";
import { isApiError, signInWithLink } from "../../lib/api.ts";
import { useMutation } from "../../lib/data.ts";
import { safeNext, useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { AuthCard, NoAccounts } from "./AuthCard.tsx";

export function SignInLink() {
  const session = useSession();
  const toast = useToast();
  const { query, navigate } = useRoute();
  const token = query.token ?? "";
  const mutation = useMutation(signInWithLink, {
    onSuccess: async () => {
      await session.refresh();
      toast.show("Signed in.");
      navigate(safeNext(query.next), { replace: true });
    },
  });

  return (
    <AuthCard title="Sign in with a link">
      <NoAccounts />
      {token === "" ? (
        <p>This link has no token. Open the whole link from the email.</p>
      ) : (
        <>
          {mutation.error !== undefined &&
            (isApiError(mutation.error, "forbidden") ? (
              <div className="notice notice-error" role="alert">
                <div className="notice-body">
                  <p>{mutation.error.message}</p>
                  <ButtonLink to="/forgot-password" size="small" variant="primary">
                    Reset password
                  </ButtonLink>
                </div>
              </div>
            ) : (
              <ErrorMessage error={mutation.error} />
            ))}
          <p>This link signs you in once, for a short while.</p>
          <Button
            variant="primary"
            className="btn-block"
            busy={mutation.pending}
            onClick={() => mutation.run({ token }).catch(() => {})}
          >
            Sign in
          </Button>
        </>
      )}
    </AuthCard>
  );
}
