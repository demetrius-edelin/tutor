import type { z } from "zod";

// One book section that the model can use and cite.
export interface Source {
  id: string;
  title: string;
  text: string;
}

// One reference in a text answer: the source and the exact quote from it.
// The text marks a reference with its number, for example "[2]".
export interface Reference {
  number: number;
  sourceId: string;
  quote: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

// An image for the model, for example a page of a book with code on it.
export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: Uint8Array;
}

export interface ObjectRequest<T> {
  system: string;
  sources?: Source[];
  // Images for the model to read. They come before the prompt.
  images?: ImageInput[];
  prompt: string;
  schema: z.ZodType<T>;
}

export interface TextRequest {
  system: string;
  sources: Source[];
  // The conversation. The first message must come from the user.
  messages: Message[];
}

export interface TextResult {
  text: string;
  references: Reference[];
}

export interface LlmClient {
  // Return JSON that matches the schema.
  object<T>(request: ObjectRequest<T>): Promise<T>;
  // Return free text, with references to the sources.
  text(request: TextRequest): Promise<TextResult>;
}

// An error with a message for the user, for example a key that is not valid.
export class LlmError extends Error {
  override name = "LlmError";
}
