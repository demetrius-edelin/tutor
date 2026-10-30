// Math as plain text. The models often write math in LaTeX, for example \(a \times b\) or $$\frac{3x + 15}{x}$$,
// also when the prompt asks for plain text (PLAIN_MATH_RULE in src/llm/prompt.ts). The app shows Markdown with no math,
// so the learner saw "(a \times b)". The app changes the LaTeX to plain text with Unicode symbols before it shows a
// text of the model: "a × b" and "(3x + 15)/x". Code blocks and inline code do not change.

const SYMBOLS: Record<string, string> = {
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "~", propto: "∝",
  ll: "≪", gg: "≫", infty: "∞", partial: "∂", nabla: "∇", circ: "∘", degree: "°", prime: "′",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐",
  Leftrightarrow: "⇔", implies: "⇒", iff: "⇔", mapsto: "↦",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩",
  emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨",
  vee: "∨", oplus: "⊕", sum: "∑", prod: "∏", int: "∫", oint: "∮", angle: "∠", perp: "⊥", parallel: "∥",
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", therefore: "∴", because: "∵",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉",
  vert: "|", mid: "|", Vert: "‖", backslash: "\\",
};

// Commands that only change the font or the size. The text in their argument stays.
const TEXT_COMMANDS = new Set([
  "text", "textrm", "textbf", "textit", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "mathbb",
  "operatorname", "boldsymbol", "mbox", "displaystyle", "textstyle", "overline", "underline", "vec", "hat", "bar",
]);

// Commands that change the size of the next delimiter. The delimiter stays.
const SIZE_COMMANDS = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr"]);

const SPACE_COMMANDS = new Set(["quad", "qquad", "enspace", "thinspace"]);

const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", k: "ₖ", m: "ₘ",
  n: "ₙ", o: "ₒ", t: "ₜ", x: "ₓ",
};

// A character after a backslash: an escaped symbol, or a space.
const ESCAPES: Record<string, string> = {
  "{": "{", "}": "}", "%": "%", $: "$", "&": "&", "#": "#", _: "\\_", ",": " ", ":": " ", ";": " ", " ": " ",
  "!": "", "\\": " ", "|": "‖",
};

// The argument of a command at position i: a group in braces, one command, or one character.
function argument(math: string, i: number): [string, number] {
  while (math[i] === " ") i++;
  if (math[i] === "{") {
    let depth = 0;
    for (let j = i; j < math.length; j++) {
      if (math[j] === "\\") {
        j++;
      } else if (math[j] === "{") {
        depth++;
      } else if (math[j] === "}" && --depth === 0) {
        return [math.slice(i + 1, j), j + 1];
      }
    }
    return [math.slice(i + 1), math.length];
  }
  if (math[i] === "\\") {
    const command = /^\\([A-Za-z]+|.)/.exec(math.slice(i))![0];
    return [command, i + command.length];
  }
  return [math[i] ?? "", i + 1];
}

// A part of a fraction with more than one term gets parentheses: (3x + 15)/x.
const group = (text: string) => (/^[\p{L}\p{N}.,′⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ]+$/u.test(text) ? text : `(${text})`);

function script(text: string, mark: "^" | "_"): string {
  if (mark === "^" && text === "∘") return "°";
  const map = mark === "^" ? SUPERSCRIPTS : SUBSCRIPTS;
  const chars = [...text];
  if (chars.length > 0 && chars.every((char) => char in map)) return chars.map((char) => map[char]).join("");
  // An underscore in Markdown can start italic text.
  if (mark === "_") return `\\_${chars.length === 1 ? text : `(${text})`}`;
  return chars.length === 1 ? `^${text}` : `^(${text})`;
}

const ROOTS: Record<string, string> = { "3": "∛", "4": "∜" };

// The plain text of the LaTeX in a math part.
function mathText(math: string): string {
  let out = "";
  let i = 0;
  while (i < math.length) {
    const char = math[i]!;
    if (char === "\\") {
      const word = /^\\([A-Za-z]+)/.exec(math.slice(i));
      if (!word) {
        const next = math[i + 1] ?? "";
        out += ESCAPES[next] ?? next;
        i += 2;
        continue;
      }
      const name = word[1]!;
      i += word[0].length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [top, afterTop] = argument(math, i);
        const [bottom, afterBottom] = argument(math, afterTop);
        out += `${group(mathText(top))}/${group(mathText(bottom))}`;
        i = afterBottom;
      } else if (name === "sqrt") {
        let index = "";
        if (math[i] === "[") {
          const end = math.indexOf("]", i);
          index = math.slice(i + 1, end);
          i = end + 1;
        }
        const [radicand, after] = argument(math, i);
        const root = ROOTS[index.trim()] ?? (index ? `${script(mathText(index), "^")}√` : "√");
        out += root + group(mathText(radicand));
        i = after;
      } else if (TEXT_COMMANDS.has(name)) {
        const [text, after] = argument(math, i);
        out += mathText(text);
        i = after;
      } else if (SPACE_COMMANDS.has(name)) {
        out += " ";
      } else if (!SIZE_COMMANDS.has(name)) {
        // An unknown command keeps its name, for example \sin x gives "sin x".
        out += SYMBOLS[name] ?? name;
      }
    } else if (char === "^" || char === "_") {
      const [text, after] = argument(math, i + 1);
      out += script(mathText(text), char);
      i = after;
    } else if (char === "{" || char === "}") {
      i++;
    } else {
      out += char === "~" ? " " : char;
      i++;
    }
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

// The math in LaTeX delimiters: \[ \], $$ $$, \( \), and $ $. A single dollar sign starts math only if a character
// that is not a space follows it, and the closing dollar sign has no digit after it, so that "$5 and $10" stays.
const MATH = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?!\d)/g;

// Some commands also come with no delimiters, for example "2 \times 5".
const BARE = /\\(times|cdot|div|pm|leq?|geq?|neq?|approx|to|rightarrow|infty|degree)(?![A-Za-z])/g;

const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;

function convert(text: string, markdown: boolean): string {
  // A text that is not Markdown shows the backslash of an escaped underscore.
  const plain = (math: string) => (markdown ? math : math.replaceAll("\\_", "_"));
  return text
    .replace(MATH, (all, display?: string, block?: string, inline?: string, dollars?: string) => {
      // A single dollar sign with plain text between, for example "$x and y$", is not math.
      if (dollars !== undefined && !/[\\^_{]/.test(dollars) && dollars.length > 2) return all;
      return plain(mathText(display ?? block ?? inline ?? dollars ?? ""));
    })
    .replace(BARE, (_all, name: string) => SYMBOLS[name]!);
}

// The text with its math as plain text. For a text that is not Markdown, set markdown to false.
export function plainMath(text: string, markdown = true): string {
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : convert(part, markdown)))
    .join("");
}
