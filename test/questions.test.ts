import { describe, expect, it } from "vitest";
import { codeBlocks, optionText, questionText, writeQuestions, writeTestQuestions, type QuestionConcept } from "../src/tutor/questions.js";
import { defaultQuestions, defaultTestQuestions, FakeLlm } from "./fakes/llm.js";

const concept: QuestionConcept = {
  id: 1,
  name: "Loops",
  objective: "Predict the output of a loop.",
  kind: "skill",
  sources: [{ sectionId: 7, title: "Loops", markdown: "A loop runs its body for each item." }],
};

describe("code in a question", () => {
  it("changes inline code of more than one line into a code block, and keeps the other code", () => {
    expect(codeBlocks('What does this code display? `mode = "easy"\nprint(Mode)`')).toBe(
      'What does this code display? \n```\nmode = "easy"\nprint(Mode)\n```',
    );
    expect(codeBlocks("Run `x = 1` first.")).toBe("Run `x = 1` first.");
    const fenced = "Look:\n```python\nx = 1\ny = `a`\n```";
    expect(codeBlocks(fenced)).toBe(fenced);
  });

  it("puts an option of more than one line into a code block", () => {
    expect(optionText("def f():\n    return 1")).toBe("```\ndef f():\n    return 1\n```");
    expect(optionText("  An error because `mode` was assigned twice ")).toBe("An error because `mode` was assigned twice");
    expect(optionText("```python\nx = 1\n```")).toBe("```python\nx = 1\n```");
  });

  it("puts the code of a question under the question, as a code block", () => {
    expect(questionText("What does this code print?", "for i in range(4):\n    print(i)\n")).toBe(
      "What does this code print?\n\n```\nfor i in range(4):\n    print(i)\n```",
    );
    // The model sometimes puts a code block in the code field.
    expect(questionText("And this code?", "```python\nprint(1)\n```")).toBe("And this code?\n\n```\nprint(1)\n```");
    expect(questionText("No code here.", null)).toBe("No code here.");
    expect(questionText("  ", "print(1)")).toBe("");
  });

  it("keeps the lines of the code in a test question, and the correct option after the change of its code", async () => {
    const code = "print('a')\nprint('b')";
    const llm = new FakeLlm({
      test: (_prompt, sources) => {
        const [recall, , apply] = defaultTestQuestions(sources[0]!.id);
        return {
          questions: [
            { ...recall, options: [code, "print('a')", "print('b')", "nothing"], correctIndex: 0 },
            { ...apply, question: "What does this code print?", code: "for i in range(2):\n    print(i)" },
          ],
        };
      },
    });
    const [choice, open] = await writeTestQuestions(llm, concept, []);
    expect(choice!.choices![Number(choice!.answer)]).toBe("```\n" + code + "\n```");
    expect(open!.text).toBe("What does this code print?\n\n```\nfor i in range(2):\n    print(i)\n```");
  });

  it("keeps the lines of the code in a diagnosis question", async () => {
    const llm = new FakeLlm({
      questions: (ids, sources) => {
        const [entry] = defaultQuestions(ids, sources).concepts;
        return { concepts: [{ ...entry!, open: { ...entry!.open, question: "What does this print?", code: "x = 1\nprint(x)" } }] };
      },
    });
    const questions = await writeQuestions(llm, [concept]);
    expect(questions.find((question) => question.kind !== "choice")!.text).toBe("What does this print?\n\n```\nx = 1\nprint(x)\n```");
  });
});
