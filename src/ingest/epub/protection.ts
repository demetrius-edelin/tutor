import type JSZip from "jszip";

// Copy protection (DRM, digital rights management) of an EPUB file. Books from Kindle, Apple Books, and other stores
// have encrypted text, so the reader gets no text. The tutor tells the user this reason. The removal of copy protection
// is illegal in the USA and in the EU, so the tutor does not try it.

export class CopyProtectedEpubError extends Error {
  override name = "CopyProtectedEpubError";
}

export const COPY_PROTECTED_EPUB =
  "This EPUB file has copy protection (DRM), so its text is encrypted. The tutor cannot read it. Books from Kindle, Apple Books, and other stores often have copy protection.";

// The font obfuscation of the IDPF and of Adobe changes only the fonts. The text stays readable.
const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"]);

// The files of the systems for copy protection: Adobe ADEPT, Readium LCP, and Apple FairPlay.
const PROTECTION_FILES = ["meta-inf/rights.xml", "meta-inf/license.lcpl", "meta-inf/sinf.xml"];

// True if the EPUB file has copy protection: a file of a protection system, or an encrypted file that is not a font.
// The paths in the ZIP file can have any case.
export async function hasCopyProtection(zip: JSZip): Promise<boolean> {
  const paths = new Map<string, string>();
  zip.forEach((path) => paths.set(path.toLowerCase(), path));
  if (PROTECTION_FILES.some((path) => paths.has(path))) return true;
  const encryptionPath = paths.get("meta-inf/encryption.xml");
  const encryption = encryptionPath ? await zip.file(encryptionPath)?.async("string") : undefined;
  if (!encryption) return false;
  const algorithms = [...encryption.matchAll(/<(?:[\w-]+:)?EncryptionMethod\b[^>]*\bAlgorithm\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  return algorithms.some((algorithm) => !FONT_OBFUSCATION.has(algorithm));
}
