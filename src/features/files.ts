// Document parsing: PDF (pdf.js), DOCX (mammoth), XLSX/CSV (SheetJS), plain text.
// Everything returns extracted text plus honest truncation metadata.
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { truncateChars } from "../lib/util";

const MAX_DOC_CHARS = 200_000;

export interface ParsedFile {
  name: string;
  kind: "pdf" | "docx" | "xlsx" | "text" | "image";
  text: string;
  truncated: boolean;
  originalChars: number;
  /** base64 data + media type for images (sent to the vision model, not parsed). */
  imageData?: { mediaType: string; base64: string };
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

async function parsePdf(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it: any) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) parts.push(`[Page ${i}]\n${text}`);
    if (parts.join("\n").length > MAX_DOC_CHARS) break;
  }
  return parts.join("\n\n");
}

async function parseDocx(buf: ArrayBuffer): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value.trim();
}

function parseXlsx(buf: ArrayBuffer): string {
  const wb = XLSX.read(buf, { type: "array" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
    if (csv) parts.push(`[Sheet: ${name}]\n${csv}`);
    if (parts.join("\n").length > MAX_DOC_CHARS) break;
  }
  return parts.join("\n\n");
}

const TEXT_EXTS = ["txt", "md", "csv", "json", "log", "html", "xml", "yaml", "yml", "js", "ts", "py"];
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function acceptedFileKinds(): string {
  return ".pdf,.docx,.xlsx,.xls,.csv," + TEXT_EXTS.map((e) => "." + e).join(",") + ",.png,.jpg,.jpeg,.gif,.webp";
}

export async function parseFile(file: File): Promise<ParsedFile> {
  const ext = (file.name.split(".").pop() || "").toLowerCase();

  if (IMAGE_TYPES[ext]) {
    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(new Error("Could not read image"));
      r.readAsDataURL(file);
    });
    return {
      name: file.name,
      kind: "image",
      text: "",
      truncated: false,
      originalChars: 0,
      imageData: { mediaType: IMAGE_TYPES[ext], base64 },
    };
  }

  let raw: string;
  if (ext === "pdf") {
    raw = await parsePdf(await file.arrayBuffer());
  } else if (ext === "docx") {
    raw = await parseDocx(await file.arrayBuffer());
  } else if (ext === "xlsx" || ext === "xls") {
    raw = parseXlsx(await file.arrayBuffer());
  } else if (ext === "csv" || TEXT_EXTS.includes(ext)) {
    raw = await file.text();
  } else {
    throw new Error(`Unsupported file type: .${ext}`);
  }

  if (!raw.trim()) throw new Error(`No readable text found in ${file.name}`);
  const { text, truncated } = truncateChars(raw, MAX_DOC_CHARS);
  const kind = ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : ext === "xlsx" || ext === "xls" ? "xlsx" : "text";
  return { name: file.name, kind, text, truncated, originalChars: raw.length };
}
