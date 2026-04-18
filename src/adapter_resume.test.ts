import assert from "node:assert/strict";
import {
  buildResumePrompt,
  snapshotMessages,
  type OpenAIMessage,
} from "./adapter.js";

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
  } catch (error: any) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error.message}`);
    process.exitCode = 1;
  }
}

function makeMessages(...messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages;
}

async function run() {
  console.log("Resume safety tests\n");

  await test("resume prompt is built for strict append-only transcript", () => {
    const previous = makeMessages(
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Summarize this repo." }
    );
    const next = makeMessages(
      ...previous,
      { role: "assistant", content: "Initial answer." },
      { role: "user", content: "Continue with risks." }
    );

    const prompt = buildResumePrompt(next, snapshotMessages(previous));

    assert.equal(
      prompt,
      "<previous_response>\nInitial answer.\n</previous_response>\n\nUser: Continue with risks."
    );
  });

  await test("resume is rejected when an earlier message changes", () => {
    const previous = makeMessages(
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Summarize this repo." }
    );
    const rewritten = makeMessages(
      { role: "system", content: "You are strict and terse." },
      { role: "user", content: "Summarize this repo." },
      { role: "assistant", content: "Initial answer." },
      { role: "user", content: "Continue with risks." }
    );

    const prompt = buildResumePrompt(rewritten, snapshotMessages(previous));

    assert.equal(prompt, null);
  });

  await test("resume is rejected when the transcript length does not grow", () => {
    const previous = makeMessages(
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" }
    );

    const prompt = buildResumePrompt(previous, snapshotMessages(previous));

    assert.equal(prompt, null);
  });

  await test("resume snapshot includes tool metadata in prefix checks", () => {
    const previous = makeMessages(
      { role: "user", content: "Check weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: "{\"city\":\"Taipei\"}" },
          },
        ],
      }
    );
    const next = makeMessages(
      { role: "user", content: "Check weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "weather", arguments: "{\"city\":\"Taipei\"}" },
          },
        ],
      },
      {
        role: "tool",
        name: "weather",
        tool_call_id: "call_2",
        content: "Rainy",
      }
    );

    const prompt = buildResumePrompt(next, snapshotMessages(previous));

    assert.equal(prompt, null);
  });

  console.log("");
}

run();
