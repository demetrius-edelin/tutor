import { describe, expect, it } from "vitest";
import { plainMath } from "../src/app/math.js";
import { PLAIN_MATH_RULE } from "../src/llm/prompt.js";
import { GRADER_SYSTEM } from "../src/tutor/grader.js";
import { CHAT_SYSTEM, LESSON_SYSTEM } from "../src/tutor/lesson.js";
import { QUESTIONS_SYSTEM, TEST_QUESTIONS_SYSTEM } from "../src/tutor/questions.js";

describe("plainMath", () => {
  it("changes the inline LaTeX of a real lesson to plain text", () => {
    expect(plainMath("For example, \\(ab\\) means \\(a \\times b\\), and \\(2x\\) means \\(2 \\times x\\).")).toBe(
      "For example, ab means a × b, and 2x means 2 × x.",
    );
    expect(plainMath("\\(2 \\times 5\\) can also be written as \\((2)(5)\\).")).toBe("2 × 5 can also be written as (2)(5).");
  });

  it("changes fractions, roots, powers, and indexes", () => {
    expect(plainMath("$$\\frac{3x + 15}{x}$$")).toBe("(3x + 15)/x");
    expect(plainMath("\\(\\frac{1}{2}\\)")).toBe("1/2");
    expect(plainMath("\\(\\sqrt{x}\\) and \\(\\sqrt{x + 1}\\) and \\(\\sqrt[3]{8}\\)")).toBe("√x and √(x + 1) and ∛8");
    expect(plainMath("\\(x^2 + y^{2} = r^2\\)")).toBe("x² + y² = r²");
    expect(plainMath("\\(10^{-3}\\), \\(x^{n+1}\\), \\(e^{x}\\), \\(2^{10x}\\)")).toBe("10⁻³, xⁿ⁺¹, e^x, 2^(10x)");
    expect(plainMath("\\(a_1 + a_n\\) and \\(x_{max}\\)")).toBe("a₁ + aₙ and xₘₐₓ");
    // A letter with no subscript character. In Markdown, the underscore has a backslash, so that it starts no italic text.
    expect(plainMath("\\(v_b\\) and \\(v_{bc}\\)")).toBe("v\\_b and v\\_(bc)");
    expect(plainMath("\\(v_b\\) and \\(v_{bc}\\)", false)).toBe("v_b and v_(bc)");
    expect(plainMath("\\(90^\\circ\\)")).toBe("90°");
  });

  it("changes symbols, Greek letters, text, and function names", () => {
    expect(plainMath("\\(a \\leq b \\neq c \\geq d \\approx e\\)")).toBe("a ≤ b ≠ c ≥ d ≈ e");
    expect(plainMath("\\(\\pi r^2\\) and \\(\\Delta x \\to 0\\)")).toBe("π r² and Δ x → 0");
    expect(plainMath("\\(\\text{area} = \\text{width} \\cdot \\text{height}\\)")).toBe("area = width · height");
    expect(plainMath("\\(\\sin x + \\log_2 y\\)")).toBe("sin x + log₂ y");
    expect(plainMath("\\(\\left( a + b \\right)\\)")).toBe("( a + b )");
    expect(plainMath("\\(50\\%\\)")).toBe("50%");
  });

  it("changes display math, single dollar signs, and commands with no delimiters", () => {
    expect(plainMath("The rule:\n\n\\[ a^2 + b^2 = c^2 \\]\n\nNext.")).toBe("The rule:\n\na² + b² = c²\n\nNext.");
    expect(plainMath("Solve $x^2 = 4$ for $x$.")).toBe("Solve x² = 4 for x.");
    expect(plainMath("So 2 \\times 5 is 10, and 3 \\div 4 is less.")).toBe("So 2 × 5 is 10, and 3 ÷ 4 is less.");
  });

  it("keeps prices, code, and text with no math", () => {
    expect(plainMath("It costs $5 and $10 later.")).toBe("It costs $5 and $10 later.");
    expect(plainMath("Between $5 and 7$ apples.")).toBe("Between $5 and 7$ apples.");
    expect(plainMath("Use `print(\"\\(x\\)\")` here.")).toBe("Use `print(\"\\(x\\)\")` here.");
    expect(plainMath("```latex\n\\frac{a}{b} \\times c\n```\nand \\(a \\times b\\)")).toBe("```latex\n\\frac{a}{b} \\times c\n```\nand a × b");
    expect(plainMath("A plain sentence (with parentheses).")).toBe("A plain sentence (with parentheses).");
    // A file name with an underscore is not math.
    expect(plainMath("Open my_file.txt", false)).toBe("Open my_file.txt");
  });

  it("is in the prompts that write text for the app", () => {
    for (const system of [LESSON_SYSTEM, CHAT_SYSTEM, QUESTIONS_SYSTEM, TEST_QUESTIONS_SYSTEM, GRADER_SYSTEM]) {
      expect(system).toContain(PLAIN_MATH_RULE);
    }
  });
});
