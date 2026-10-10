// SPDX-License-Identifier: MIT
import { Button, Details, Summary, Input, Label, Table, TextArea } from "@quaso/design-system";
import type { QualityJobInfo, TerminologySuggestion, StyleGuideDraft } from "@quaso/core";
import { useState } from "react";
import { request } from "../lib/api.ts";
import { useMutation } from "../lib/data.ts";
import { useSession } from "../lib/session.tsx";
import { Link } from "../lib/router.tsx";
import { editorHref } from "../pages/LanguagePage.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";

export function TerminologyReview({
  job,
}: {
  job: Extract<QualityJobInfo, { kind: "terminology" }>;
}) {
  return (
    <div className="table-scroll">
      <Table className="data-table">
        <thead>
          <tr>
            <th>Source term</th>
            <th>Existing renderings</th>
            <th>Preferred translation</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {job.result.map((proposal, index) => (
            <TermRow key={`${job.id}:${index}`} jobId={job.id} index={index} proposal={proposal} />
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function TermRow({
  jobId,
  index,
  proposal,
}: {
  jobId: number;
  index: number;
  proposal: TerminologySuggestion;
}) {
  const [preferred, setPreferred] = useState(proposal.preferred);
  const session = useSession();
  const review = useMutation(
    (action: "accept" | "dismiss") =>
      request<QualityJobInfo>(`/quality-jobs/${jobId}/suggestions/${index}`, {
        method: "PATCH",
        body: { action, translation: preferred },
      }),
    { invalidate: [["qualityJob", jobId], ["qualityJobs"], ["glossary"], ["string"], ["strings"]] },
  );
  const green = [
    ...new Set(
      proposal.occurrences.filter((entry) => entry.colour === "green").map((entry) => entry.id),
    ),
  ];
  const translate = useMutation(
    async () => {
      for (let offset = 0; offset < green.length; offset += 500)
        await request("/jobs", {
          method: "POST",
          body: {
            languages: [proposal.language],
            strings: green.slice(offset, offset + 500),
            retranslate: true,
            outdated: false,
            instruction: "Use the agreed glossary terminology consistently.",
          },
        });
    },
    { invalidate: [["jobs"]] },
  );
  const mayReview = session.can("glossary", proposal.language);
  const pending = proposal.status === "pending";
  const hasGlossary = proposal.status === "accepted" || proposal.glossaryId !== undefined;
  return (
    <tr>
      <td>
        <strong>{proposal.term}</strong>
        <p>
          {proposal.language} · {proposal.count} strings · {proposal.files} files
        </p>
        {proposal.note && <p className="small muted">{proposal.note}</p>}
      </td>
      <td>
        {proposal.inconsistent && <p className="notice-warning">Inconsistent terminology</p>}
        <ul>
          {proposal.renderings.map((rendering) => (
            <li key={rendering.translation}>
              {rendering.translation} ({rendering.count})
            </li>
          ))}
        </ul>
        <Details>
          <Summary>Source examples ({proposal.occurrences.length})</Summary>
          <ul>
            {proposal.occurrences.map((entry) => (
              <li key={entry.id}>
                <Link to={editorHref(entry.language, { id: entry.id, file: entry.file })}>
                  {entry.file} › {entry.key}
                </Link>
                : {entry.rendering || "untranslated"}
              </li>
            ))}
          </ul>
        </Details>
      </td>
      <td>
        <Label className="sr-only" htmlFor={`preferred-${jobId}-${index}`}>
          Preferred translation of {proposal.term}
        </Label>
        <Input
          id={`preferred-${jobId}-${index}`}
          value={preferred}
          onChange={(event) => setPreferred(event.target.value)}
          disabled={!mayReview || !pending || proposal.kind === "keep"}
          maxLength={1000}
        />
        {proposal.kind === "keep" && <p>Never translate</p>}
      </td>
      <td>
        {pending && mayReview ? (
          <div className="actions">
            <Button
              busy={review.pending}
              disabled={!preferred.trim()}
              onClick={() => review.run("accept").catch(() => {})}
            >
              Accept term
            </Button>
            <Button disabled={review.pending} onClick={() => review.run("dismiss").catch(() => {})}>
              Dismiss
            </Button>
          </div>
        ) : (
          <p>{proposal.status}</p>
        )}
        {proposal.inconsistent && green.length > 0 && (
          <Button
            disabled={!hasGlossary}
            busy={translate.pending}
            onClick={() => translate.run().catch(() => {})}
          >
            Re-translate {green.length} green strings with the glossary
          </Button>
        )}
        {review.error !== undefined && <ErrorMessage error={review.error} />}
        {translate.error !== undefined && <ErrorMessage error={translate.error} />}
      </td>
    </tr>
  );
}

export function StyleGuideReview({ drafts }: { drafts: StyleGuideDraft[] }) {
  return (
    <div>
      {drafts.map((draft) => (
        <StyleDraft key={draft.language} draft={draft} />
      ))}
    </div>
  );
}
function StyleDraft({ draft }: { draft: StyleGuideDraft }) {
  const [instructions, setInstructions] = useState(draft.instructions);
  const session = useSession();
  const [saved, setSaved] = useState(false);
  const save = useMutation(
    () => request(`/languages/${draft.language}`, { method: "PATCH", body: { instructions } }),
    { invalidate: [["settings"], ["project"]], onSuccess: () => setSaved(true) },
  );
  return (
    <section>
      <p>
        {draft.language}: draft from {draft.samples} proofread translations. Review register,
        region, punctuation and placeholder spacing before saving.
      </p>
      <Label>
        Language instructions
        <TextArea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={20_000}
          disabled={!session.can("settings")}
        />
      </Label>
      {session.can("settings") && (
        <Button busy={save.pending} onClick={() => save.run().catch(() => {})}>
          Save language instructions
        </Button>
      )}
      {saved && <p role="status">Language instructions saved.</p>}
      {save.error !== undefined && <ErrorMessage error={save.error} />}
    </section>
  );
}
