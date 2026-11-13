import { expect, test } from "vitest";
import { sha256Hex } from "../hash";
import { docIdFor } from "../ids";

test("the F§5.2 golden docId for one block", () => {
  expect(docIdFor(["Hello, world."])).toBe("f8c3bf62a9aa3e6fc1619c250e48abe7");
});

test("the F§5.2 golden docId for two blocks", () => {
  expect(docIdFor(["Title", "Hello, world. Second sentence here."])).toBe("684c0459dd47803dec1ee32224195049");
});

test("block texts are joined with one newline and the digest is truncated to 32 characters", () => {
  expect(docIdFor(["a", "b"])).toBe(sha256Hex("a\nb").slice(0, 32));
  expect(docIdFor(["Hello, world."])).toBe(sha256Hex("Hello, world.").slice(0, 32));
  expect(docIdFor(["Hello, world."])).toHaveLength(32);
  expect(docIdFor(["ab"])).not.toBe(docIdFor(["a", "b"]));
});
