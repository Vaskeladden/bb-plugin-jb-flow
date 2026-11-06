import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DecisionChips } from "./decision-choices";

afterEach(cleanup);
const options = [
  {
    n: 1,
    text: "Build step 3 for builds and pre-choruses, keeping the existing measurement and full validation intact",
    recommended: true,
  },
  { n: 2, text: "Stop here; the measurement is enough", recommended: false },
];
it("shows full choice text and recommendation, sends only the number, and prevents duplicate replies", async () => {
  let finish!: (value: { ok: boolean }) => void;
  const reply = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    {
      rpc: { decision_options: () => ({ groups: [{ mode: "choice" as const, question: "", options }] }), thread_reply: reply },
    },
  );
  const button = await slot.findByRole("button", {
    name: `Reply 1: ${options[0].text} (recommended)`,
  });
  expect(slot.getByText("Recommended")).toBeTruthy();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "1" }]);
  expect(slot.getByText("Sending…")).toBeTruthy();
  finish({ ok: true });
  await slot.findByText("Reply sent");
  expect(slot.getByRole("status").textContent).toBe("Reply 1 sent");
  expect(button.hasAttribute("disabled")).toBe(true);
  slot.lifecycle.unmount();
});
it("shows a failed send and re-enables every choice for retry", async () => {
  const reply = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    {
      rpc: { decision_options: () => ({ groups: [{ mode: "choice" as const, question: "", options }] }), thread_reply: reply },
    },
  );
  const button = await slot.findByRole("button", {
    name: `Reply 2: ${options[1].text}`,
  });
  fireEvent.click(button);
  await slot.findByRole("alert");
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  await slot.findByRole("status");
  expect(reply).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});
it("fetches nothing while running or without a thread, and ignores results after unmount", async () => {
  const read = vi.fn(() => ({ groups: [{ mode: "choice" as const, question: "", options }] }));
  const running = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: false },
    { rpc: { decision_options: read } },
  );
  expect(read).not.toHaveBeenCalled();
  expect(running.queryByRole("region")).toBeNull();
  running.lifecycle.unmount();
  let finish!: (value: { groups: { mode: "choice"; question: string; options: typeof options }[] }) => void;
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    {
      rpc: {
        decision_options: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  slot.lifecycle.unmount();
  finish({ groups: [{ mode: "choice", question: "", options }] });
});
it("offers a go-list as steps to tick and Go, sending go or go with the picked steps", async () => {
  const steps = { groups: [{ mode: "go" as const, question: "", options: [...options, { n: 3, text: "Tidy the docs", recommended: false }] }] };
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const all = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => steps, thread_reply: reply } },
  );
  fireEvent.click(await all.findByRole("button", { name: "Go" }));
  await all.findByText("Sent “go”");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "go" }]);
  expect(all.getByRole("checkbox", { name: /Tidy the docs/ }).hasAttribute("disabled")).toBe(true);
  all.lifecycle.unmount();

  const some = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 2, idle: true },
    { rpc: { decision_options: () => steps, thread_reply: reply } },
  );
  fireEvent.click(await some.findByRole("checkbox", { name: /Tidy the docs/ }));
  fireEvent.click(some.getByRole("checkbox", { name: `Step 1: ${options[0].text} (recommended)` }));
  expect(some.getByRole("checkbox", { name: /Tidy the docs/ }).getAttribute("aria-checked")).toBe("true");
  const go = some.getByRole("button", { name: "Go with 1, 3" });
  fireEvent.click(go);
  fireEvent.click(go);
  await some.findByText("Sent “go 1,3”");
  expect(reply).toHaveBeenCalledTimes(2);
  expect(reply.mock.calls[1]).toEqual([{ threadId: "t1", text: "go 1,3" }]);
  some.lifecycle.unmount();
});
it("lets a failed Go be retried", async () => {
  const reply = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ groups: [{ mode: "go" as const, question: "", options }] }), thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Go" }));
  await slot.findByRole("alert");
  fireEvent.click(slot.getByRole("button", { name: "Go" }));
  await slot.findByText("Sent “go”");
  expect(reply).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});

it("shows steps and a decision as two groups and sends both answers at once", async () => {
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const groups = {
    groups: [
      { mode: "go" as const, question: "", options: [...options, { n: 3, text: "Tidy the docs", recommended: false }] },
      {
        mode: "choice" as const,
        question: "which rollout?",
        options: [
          { n: 1, text: "10% today", recommended: true },
          { n: 2, text: "Everyone on Monday", recommended: false },
        ],
      },
    ],
  };
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => groups, thread_reply: reply } },
  );
  expect((await slot.findAllByRole("checkbox")).length).toBe(3);
  expect(slot.getAllByRole("radio").length).toBe(2);
  const send = slot.getByRole("button", { name: "Choose an option to send" });
  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.click(slot.getByRole("checkbox", { name: /Tidy the docs/ }));
  fireEvent.click(slot.getByRole("radio", { name: /Everyone on Monday/ }));
  expect(reply).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Send “go 3; decision: 2”" }));
  await slot.findByText("Sent “go 3; decision: 2”");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "go 3; decision: 2" }]);
  slot.lifecycle.unmount();
});

it("asks two decisions as two groups and sends each answer tied to its question", async () => {
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const two = (question: string) => ({
    mode: "choice" as const,
    question,
    options: [
      { n: 1, text: `${question} yes`, recommended: true },
      { n: 2, text: `${question} no`, recommended: false },
    ],
  });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ groups: [two("Money page"), two("Test site")] }), thread_reply: reply } },
  );
  expect((await slot.findAllByRole("radio")).length).toBe(4);
  expect(slot.getByText("Decision 1: Money page")).toBeTruthy();
  expect(slot.getByText("Decision 2: Test site")).toBeTruthy();
  fireEvent.click(slot.getByRole("radio", { name: /Money page yes/ }));
  expect(slot.getByRole("button", { name: "Choose an option to send" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(slot.getByRole("radio", { name: /Test site no/ }));
  fireEvent.click(slot.getByRole("button", { name: "Send “decision 1: 1; decision 2: 2”" }));
  await slot.findByText("Sent “decision 1: 1; decision 2: 2”");
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "decision 1: 1; decision 2: 2" }]);
  slot.lifecycle.unmount();
});
it("shows a lone decision's question, and says what it shows for the message to hide", async () => {
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ groups: [{ mode: "choice" as const, question: "Which rollout?", options }] }) } },
  );
  await slot.findByText("Which rollout?");
  const section = slot.getByRole("region");
  expect(JSON.parse(section.getAttribute("data-questions")!)).toEqual([{ question: "Which rollout?", options: options.map((option) => option.text) }]);
  slot.lifecycle.unmount();
});
it("keeps the box and its sent state when a thread update leaves the same question", async () => {
  const groups = { groups: [{ mode: "choice" as const, question: "Which rollout?", options }] };
  const load = vi.fn(() => groups);
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: load, thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("button", { name: /^Reply 2:/ }));
  await slot.findByText("Reply sent");
  slot.rerender(<DecisionChips threadId="t1" updatedAt={2} idle />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(slot.getByText("Reply sent")).toBeTruthy();
  slot.lifecycle.unmount();
});
it("sends the trigger word for a shipit or polish option, and the number otherwise", async () => {
  const { answerFor } = await import("./decision-choices");
  expect(answerFor({ n: 1, text: "shipit · review loop, then merge" })).toBe("shipit");
  expect(answerFor({ n: 1, text: "Ship it · merge now" })).toBe("shipit");
  expect(answerFor({ n: 2, text: "/pr-polish · same loop, no merge" })).toBe("polish pr");
  expect(answerFor({ n: 3, text: "Wait for Simen" })).toBe("3");
  expect(answerFor({ n: 4, text: "Shipping later is fine" })).toBe("4");
  const reply = vi.fn().mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: DecisionChips },
    { threadId: "t1", updatedAt: 1, idle: true },
    { rpc: { decision_options: () => ({ groups: [{ mode: "choice" as const, question: "Ship it?", options: [{ n: 1, text: "shipit · review loop, then merge", recommended: true }, { n: 2, text: "Wait", recommended: false }] }] }), thread_reply: reply } },
  );
  fireEvent.click(await slot.findByRole("button", { name: /^Reply 1:/ }));
  await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
  expect(reply.mock.calls[0]).toEqual([{ threadId: "t1", text: "shipit" }]);
  slot.lifecycle.unmount();
});
