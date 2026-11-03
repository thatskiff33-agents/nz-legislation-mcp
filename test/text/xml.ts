// Helpers for XML tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const XML_DIR = join(import.meta.dirname, "..", "fixtures", "xml");

export const loadXml = (name: string): string => readFileSync(join(XML_DIR, name), "utf8");

/** Streams text in small chunks so tag boundaries fall mid-chunk. */
export async function* chunked(text: string, size = 997): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) {
    await Promise.resolve();
    yield text.slice(i, i + size);
  }
}

/** A synthetic Act with many parts/sections (for outline-size behaviour). */
export function bigAct(parts: number, sectionsPerPart: number, extras = ""): string {
  let body = extras;
  let n = 1;
  for (let p = 1; p <= parts; p += 1) {
    body += `<part><label>${String(p)}</label><heading>Part ${String(p)}</heading><subpart><label>${String(p)}A</label><heading>Sub ${String(p)}</heading>`;
    for (let s = 0; s < sectionsPerPart; s += 1, n += 1) {
      body += `<prov><label>${String(n)}</label><heading>Section ${String(n)}</heading><prov.body><subprov><label/><para><text>Text of section ${String(n)}.</text></para></subprov></prov.body></prov>`;
    }
    body += "</subpart></part>";
  }
  const schedule =
    "<schedule.group><schedule><label>1</label><heading>Forms</heading></schedule></schedule.group>";
  return `<act><cover><title>Big Act 2099</title></cover><body>${body}</body>${schedule}</act>`;
}
