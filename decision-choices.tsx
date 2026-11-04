import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DecisionGroup } from "./decisions";
import { Icon } from "@/components/ui/icon";
import "./decision-choices.css";

export function DecisionChips({
  threadId,
  updatedAt,
  idle,
}: {
  threadId: string | null;
  updatedAt: number | null;
  idle: boolean;
}) {
  return threadId && idle ? (
    <Choices key={`${threadId}:${updatedAt}`} threadId={threadId} />
  ) : null;
}

/** "go" for all steps, or "go 1,3" for the ticked ones. */
function goText(picked: readonly number[]): string {
  const steps = [...picked].sort((a, b) => a - b);
  return steps.length ? `go ${steps.join(",")}` : "go";
}

function Choices({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [groups, setGroups] = useState<DecisionGroup[]>([]);
  // Per group: ticked steps for a go-list, the one chosen option for a decision.
  const [picked, setPicked] = useState<number[][]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    rpc.call("decision_options", { threadId }).then(
      (result) => {
        if (live) setGroups(result.groups.filter((group) => group.options.length > 0));
      },
      () => {
        if (live) setGroups([]);
      },
    );
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [rpc, threadId]);
  if (!groups.length) return null;
  // One decision alone answers on click; anything else is picked first and sent once.
  const instant = groups.length === 1 && groups[0]!.mode === "choice";
  const pickedIn = (index: number) => picked[index] ?? [];
  const toggle = (index: number, n: number, single: boolean) =>
    setPicked((current) => {
      const next = groups.map((_, i) => current[i] ?? []);
      const mine = next[index]!;
      next[index] = single ? (mine.includes(n) ? [] : [n]) : mine.includes(n) ? mine.filter((value) => value !== n) : [...mine, n];
      return next;
    });
  // The reply for several groups names each answer; a lone group keeps its usual "go …" or number.
  const missing = groups.some((group, index) => group.mode === "choice" && pickedIn(index).length === 0);
  // Several decisions name theirs by position ("decision 2: 1"), so each answer stays tied to its question.
  const decisions = groups.filter((group) => group.mode === "choice").length;
  let decisionNumber = 0;
  const composed = groups
    .map((group, index) => {
      if (group.mode === "go") return goText(pickedIn(index));
      const answer = String(pickedIn(index)[0]);
      if (groups.length === 1) return answer;
      decisionNumber += 1;
      return decisions > 1 ? `decision ${decisionNumber}: ${answer}` : `decision: ${answer}`;
    })
    .join("; ");
  const reply = async (text: string) => {
    if (locked.current) return;
    locked.current = true;
    setPending(text);
    setError(null);
    try {
      await rpc.call("thread_reply", { threadId, text });
      if (mounted.current) {
        setSent(text);
        setPending(null);
      }
    } catch {
      if (mounted.current) {
        locked.current = false;
        setPending(null);
        setError(instant ? "Reply could not be sent. Choose an option to retry." : "Reply could not be sent. Press the button to retry.");
      }
    }
  };
  const busy = pending !== null || sent !== null;
  const onlyGo = groups.length === 1 && groups[0]!.mode === "go";
  const buttonText =
    pending !== null
      ? "Sending…"
      : onlyGo
        ? pickedIn(0).length
          ? `Go with ${[...pickedIn(0)].sort((a, b) => a - b).join(", ")}`
          : "Go"
        : missing
          ? "Choose an option to send"
          : `Send “${composed}”`;
  return (
    <section className="jf-choices" aria-label="Reply choices" data-mode={instant ? "choice" : "go"}>
      <div className="jf-choices-heading">
        <Icon name="MessageCircle" className="size-3.5" />
        <span>YOUR NEXT MOVE</span>
        <span className="jf-choices-hint">{instant ? "Choose a reply" : onlyGo ? "Pick steps, or Go for all" : groups.some((group) => group.mode === "go") ? "Pick steps and an answer, then send" : "Answer each, then send"}</span>
      </div>
      {groups.map((group, index) => {
        const go = group.mode === "go";
        return (
          <div key={index} className="jf-choices-group" role="group" aria-label={go ? "Steps" : group.question || "Decision"}>
            {groups.length > 1 && (
              <p className="jf-choices-question">
                {go ? "Steps" : `${decisions > 1 ? `Decision ${groups.slice(0, index + 1).filter((g) => g.mode === "choice").length}` : "Decision"}${group.question ? `: ${group.question}` : ""}`}
              </p>
            )}
            <div className="jf-choices-list">
              {group.options.map((option) => {
                const text = String(option.n);
                const selected = instant ? pending === text || sent === text : pickedIn(index).includes(option.n);
                const label = `${go ? "Step" : instant ? "Reply" : "Option"} ${option.n}: ${option.text}${option.recommended ? " (recommended)" : ""}`;
                return (
                  <button
                    key={option.n}
                    type="button"
                    role={go ? "checkbox" : instant ? undefined : "radio"}
                    className="jf-choice"
                    data-recommended={option.recommended}
                    data-selected={selected}
                    aria-checked={go || !instant ? selected : undefined}
                    disabled={busy}
                    aria-label={label}
                    aria-busy={instant && pending === text}
                    title={option.text}
                    onClick={() => (instant ? void reply(text) : toggle(index, option.n, !go))}
                  >
                    <span className="jf-choice-number" aria-hidden="true">
                      {instant && pending === text ? (
                        <Icon name="Loader" className="jf-choice-spinner size-3" />
                      ) : selected ? (
                        <Icon name="Check" className="size-3" />
                      ) : (
                        option.n
                      )}
                    </span>
                    <span className="jf-choice-text">{option.text}</span>
                    {(option.recommended || (instant && (pending === text || sent === text))) && (
                      <span className="jf-choice-meta">
                        {instant && pending === text ? "Sending…" : instant && sent === text ? "Reply sent" : "Recommended"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {!instant && (
        <div className="jf-choices-actions">
          {sent === null ? (
            <button
              type="button"
              className="jf-choices-go"
              disabled={pending !== null || missing}
              aria-busy={pending !== null}
              onClick={() => void reply(onlyGo ? goText(pickedIn(0)) : composed)}
            >
              {buttonText}
            </button>
          ) : (
            <span role="status">Sent “{sent}”</span>
          )}
        </div>
      )}
      {error && (
        <p className="jf-choices-error" role="alert">
          {error}
        </p>
      )}
      {instant && sent !== null && (
        <span className="jf-choices-confirmation" role="status">
          Reply {sent} sent
        </span>
      )}
    </section>
  );
}
