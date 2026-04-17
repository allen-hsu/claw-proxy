import assert from "node:assert/strict";
import { parseToolCalls, sanitizeAssistantText } from "./adapter.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (e: any) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("Adapter output tests\n");

test("removes tagged thinking blocks", () => {
  const text = "Before\n<thinking>secret chain of thought</thinking>\nAfter";
  assert.equal(sanitizeAssistantText(text), "Before\n\nAfter");
});

test("removes fenced tool_call blocks from visible text", () => {
  const text = "Working...\n```xml\n<tool_call>\n{\"name\":\"exec\",\"arguments\":{\"cmd\":\"ls\"}}\n</tool_call>\n```\nDone";
  assert.equal(sanitizeAssistantText(text), "Working...\n\nDone");
});

test("parseToolCalls strips visible tool markup but keeps tool call payload", () => {
  const text = "I'll use a tool.\n<tool_call>\n{\"name\":\"exec\",\"arguments\":{\"cmd\":\"pwd\"}}\n</tool_call>";
  const parsed = parseToolCalls(text);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.cleanText, "I'll use a tool.");
});

console.log("");
