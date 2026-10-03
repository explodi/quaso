// SPDX-License-Identifier: MIT
/** A signed-in visitor asks administrators for a contributor role. */
import { useState } from "react";
import { useSession } from "../lib/session.tsx";
import { useMutation } from "../lib/data.ts";
import { fieldError } from "../lib/forms.ts";
import { requestVolunteer } from "../lib/management-api.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { HumanCheck } from "./HumanCheck.tsx";
import { LanguagePicker, TextField } from "./Management.tsx";
import { useToast } from "./Toast.tsx";

export function VolunteerDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const session = useSession();
  const toast = useToast();
  const [languages, setLanguages] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [humanCheck, setHumanCheck] = useState("");
  const mutation = useMutation(requestVolunteer, {
    onSuccess: async () => {
      await session.refresh();
      toast.show("Your volunteer request is pending. An administrator will review it.");
      onClose();
    },
  });
  return (
    <Dialog title="Become a volunteer" open={open} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.run({ languages, message, humanCheck: humanCheck || undefined }).catch(() => {});
        }}
      >
        <p>Choose the languages you can help with and introduce yourself to the team.</p>
        {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
        <LanguagePicker
          value={languages}
          onChange={(value) => setLanguages(value ?? [])}
          error={fieldError(mutation.error, "languages")}
        />
        <TextField
          label="Message"
          value={message}
          onChange={setMessage}
          maxLength={4000}
          error={fieldError(mutation.error, "message")}
        />
        <HumanCheck onToken={setHumanCheck} />
        <Button
          type="submit"
          variant="primary"
          busy={mutation.pending}
          disabled={!!session.info.humanCheck && !humanCheck}
        >
          Send volunteer request
        </Button>
      </form>
    </Dialog>
  );
}
